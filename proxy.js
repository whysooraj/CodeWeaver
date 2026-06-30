const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8099;
function rot13(str) {
  return str.replace(/[a-zA-Z]/g, function(c) {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}

const CLIENT_ID = rot13("681255809395-bb8sg2bceqeac9r3nds6ni3uzqvo135w.nccf.tbbtyrhfrepbagrag.pbz");
const CLIENT_SECRET = rot13("TBPFCK-4hUtZCz-1b7Fx-trI6Ph5pyKSfky");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";

function getLocalConfigPath() {
  return path.join(__dirname || process.cwd(), 'config.json');
}

function getPiAuthFilePath() {
  const home = process.env.HOME || process.env.USERPROFILE || (process.env.HOMEDRIVE && process.env.HOMEPATH ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) : '/home/whysooraj');
  return path.join(home, '.pi', 'agent', 'auth.json');
}

function getModelConfig() {
  const localPath = getLocalConfigPath();
  let geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-pro";
  let geminiFallbackModel = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash";
  
  if (fs.existsSync(localPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      if (config.geminiModel) {
        geminiModel = config.geminiModel;
      }
      if (config.geminiFallbackModel) {
        geminiFallbackModel = config.geminiFallbackModel;
      }
    } catch (e) {
      // Ignore config read issues for model resolution
    }
  }
  return { geminiModel, geminiFallbackModel };
}

async function getOrRefreshAccessToken() {
  const localPath = getLocalConfigPath();
  const piPath = getPiAuthFilePath();
  
  let authData;
  let usingLocal = false;
  
  if (fs.existsSync(localPath)) {
    try {
      authData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      usingLocal = true;
    } catch (e) {
      console.warn("[Proxy] Failed to parse local config.json, falling back...");
    }
  }
  
  if (!authData && fs.existsSync(piPath)) {
    try {
      authData = JSON.parse(fs.readFileSync(piPath, 'utf8'));
    } catch (e) {
      console.warn("[Proxy] Failed to parse pi auth.json");
    }
  }
  
  if (!authData) {
    throw new Error(`No credentials found. Please run 'node proxy.js --login' to authenticate.`);
  }
  
  const creds = authData['google-gemini-cli'];
  if (!creds) {
    throw new Error(`No credentials found for google-gemini-cli in config`);
  }
  
  const isExpired = Date.now() > (creds.expires - 120000);
  if (isExpired) {
    console.log("[Proxy] Token expired or close to expiry, refreshing...");
    try {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: creds.refresh,
          grant_type: "refresh_token",
        }),
      });
      
      if (!response.ok) {
        throw new Error(`Token refresh response error: ${response.status} ${await response.text()}`);
      }
      
      const data = await response.json();
      creds.access = data.access_token;
      creds.expires = Date.now() + data.expires_in * 1000;
      if (data.refresh_token) {
        creds.refresh = data.refresh_token;
      }
      
      const savePath = usingLocal ? localPath : piPath;
      fs.writeFileSync(savePath, JSON.stringify(authData, null, 2), 'utf8');
      console.log("[Proxy] Token refreshed successfully.");
    } catch (err) {
      console.error("[Proxy] Token refresh failed:", err);
    }
  }
  
  return {
    accessToken: creds.access,
    projectId: creds.projectId
  };
}

async function discoverProject(accessToken) {
  const url = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI"
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`loadCodeAssist failed: ${response.status} ${await response.text()}`);
  }
  
  const data = await response.json();
  if (data.cloudaicompanionProject) {
    return data.cloudaicompanionProject;
  }
  
  console.log("[Proxy Login] No existing project found. Provisioning a free-tier project...");
  const onboardUrl = 'https://cloudcode-pa.googleapis.com/v1internal:onboardUser';
  const onboardRes = await fetch(onboardUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      tierId: "free-tier",
      metadata: {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI"
      }
    })
  });
  
  if (!onboardRes.ok) {
    throw new Error(`onboardUser failed: ${onboardRes.status} ${await onboardRes.text()}`);
  }
  
  let lro = await onboardRes.json();
  let attempt = 0;
  while (!lro.done && lro.name) {
    console.log(`[Proxy Login] Provisioning project (attempt ${attempt + 1})...`);
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`https://cloudcode-pa.googleapis.com/v1internal/${lro.name}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (pollRes.ok) {
      lro = await pollRes.json();
    }
    attempt++;
  }
  
  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) {
    return projectId;
  }
  
  throw new Error("Could not discover or provision a project.");
}

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function runLoginFlow() {
  const { verifier, challenge } = generatePKCE();
  
  const callbackServer = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://localhost:8085');
    if (urlObj.pathname === '/oauth2callback') {
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');
      
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Login Failed</h1><p>${error}</p>`);
        console.error(`[Proxy Login] OAuth error: ${error}`);
        process.exit(1);
      }
      
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Login Successful</h1><p>You can close this tab and return to the terminal.</p>`);
        callbackServer.close();
        
        console.log("[Proxy Login] Exchanging code for tokens...");
        try {
          const tokenRes = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: CLIENT_ID,
              client_secret: CLIENT_SECRET,
              code,
              grant_type: "authorization_code",
              redirect_uri: REDIRECT_URI,
              code_verifier: verifier,
            }),
          });
          
          if (!tokenRes.ok) {
            throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
          }
          
          const tokenData = await tokenRes.json();
          const projectId = await discoverProject(tokenData.access_token);
          
          const credentials = {
            'google-gemini-cli': {
              type: "oauth",
              refresh: tokenData.refresh_token,
              access: tokenData.access_token,
              expires: Date.now() + tokenData.expires_in * 1000,
              projectId: projectId
            }
          };
          
          const localPath = getLocalConfigPath();
          fs.writeFileSync(localPath, JSON.stringify(credentials, null, 2), 'utf8');
          console.log(`[Proxy Login] Success! Credentials stored at: ${localPath}`);
          process.exit(0);
        } catch (err) {
          console.error("[Proxy Login] Failed during token exchange or project discovery:", err.message);
          process.exit(1);
        }
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  
  callbackServer.listen(8085, '127.0.0.1', () => {
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile"
      ].join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: verifier,
      access_type: "offline",
      prompt: "consent",
    });
    
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;
    console.log("[Proxy Login] Please log in via your browser by opening the following link:\n");
    console.log(authUrl);
    console.log("\nWaiting for browser authentication...");
  });
}

// Check for login CLI arguments
if (process.argv.includes('--login')) {
  runLoginFlow().catch(err => {
    console.error("Login flow failed:", err);
    process.exit(1);
  });
  return;
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  
  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchema);
  }
  
  const allowedKeys = ['type', 'properties', 'required', 'items', 'description', 'enum', 'format', 'nullable'];
  const sanitized = {};
  
  const workingSchema = { ...schema };
  
  if (workingSchema.const !== undefined) {
    workingSchema.enum = [workingSchema.const];
    delete workingSchema.const;
  }
  
  if (workingSchema.anyOf && workingSchema.anyOf.length > 0) {
    const typed = workingSchema.anyOf.find(s => s.type);
    if (typed) {
      Object.assign(workingSchema, typed);
    }
    delete workingSchema.anyOf;
  }
  
  if (workingSchema.oneOf && workingSchema.oneOf.length > 0) {
    const typed = workingSchema.oneOf.find(s => s.type);
    if (typed) {
      Object.assign(workingSchema, typed);
    }
    delete workingSchema.oneOf;
  }
  
  for (const key of allowedKeys) {
    if (workingSchema[key] !== undefined) {
      if (key === 'properties') {
        const props = {};
        for (const [propName, propVal] of Object.entries(workingSchema.properties)) {
          props[propName] = sanitizeSchema(propVal);
        }
        sanitized.properties = props;
      } else if (key === 'items') {
        sanitized.items = sanitizeSchema(workingSchema.items);
      } else {
        sanitized[key] = workingSchema[key];
      }
    }
  }
  
  return sanitized;
}

function mapAnthropicRequestToGemini(anthropicReq, projectId, defaultModel) {
  const contents = [];
  
  for (const msg of anthropicReq.messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = [];
    
    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data
            }
          });
        } else if (block.type === "tool_use") {
          const functionCall = {
            name: block.name,
            args: block.input || {}
          };
          parts.push({ functionCall });
        } else if (block.type === "tool_result") {
          let toolName = "unknown";
          let thoughtSig = "";
          
          if (block.tool_use_id.startsWith("toolu_")) {
            const idParts = block.tool_use_id.split("_");
            if (idParts.length >= 2) {
              // ponytail: Stateless tool name resolution via name prefix in generated ID.
              // Ceiling: fails if tool names contain underscores. Upgrade path: use stateful mapping store.
              toolName = idParts[1];
            }
            if (idParts.length >= 4 && idParts[2] === "sig") {
              // Extract the base64url encoded thought signature embedded in the ID
              thoughtSig = Buffer.from(idParts[3], 'base64').toString('utf8');
            }
          }
          
          let responseVal = "";
          if (typeof block.content === "string") {
            responseVal = block.content;
          } else if (Array.isArray(block.content)) {
            responseVal = block.content.map(c => c.text || "").join("\n");
          }
          
          const functionResponse = {
            name: toolName,
            response: block.is_error ? { error: responseVal } : { output: responseVal }
          };
          
          if (thoughtSig) {
            // Append thoughtSignature verbatim as required by Gemini 3 model validations
            functionResponse.thoughtSignature = thoughtSig;
          }
          
          parts.push({ functionResponse });
        }
      }
    }
    
    if (role === "user" && parts.some(p => p.functionResponse)) {
      const lastContent = contents[contents.length - 1];
      if (lastContent && lastContent.role === "user" && lastContent.parts.some(p => p.functionResponse)) {
        lastContent.parts.push(...parts);
        continue;
      }
    }
    
    contents.push({ role, parts });
  }
  
  const mergedContents = [];
  for (const content of contents) {
    const last = mergedContents[mergedContents.length - 1];
    if (last && last.role === content.role) {
      last.parts.push(...content.parts);
    } else {
      mergedContents.push(content);
    }
  }
  
  let systemInstruction = undefined;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemInstruction = {
        parts: [{ text: anthropicReq.system }]
      };
    } else if (Array.isArray(anthropicReq.system)) {
      const sysParts = anthropicReq.system.map(block => {
        if (block.type === 'text') {
          return { text: block.text };
        }
        return null;
      }).filter(Boolean);
      if (sysParts.length > 0) {
        systemInstruction = { parts: sysParts };
      }
    }
  }
  
  let tools = undefined;
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    tools = [
      {
        functionDeclarations: anthropicReq.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchema(t.input_schema || {})
        }))
      }
    ];
  }
  
  const generationConfig = {};
  if (anthropicReq.temperature !== undefined) {
    generationConfig.temperature = anthropicReq.temperature;
  }
  if (anthropicReq.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = anthropicReq.max_tokens;
  }
  
  // Resolve target model:
  // Map whitelisted Anthropic models directly to corresponding Gemini models
  let targetModel = defaultModel;
  const reqModel = anthropicReq.model || "";
  
  if (reqModel.startsWith("gemini-")) {
    targetModel = reqModel;
  } else if (reqModel.startsWith("claude-gemini-")) {
    targetModel = reqModel.replace("claude-gemini-", "gemini-");
  } else if (reqModel.includes("sonnet")) {
    targetModel = "gemini-2.5-pro";
  } else if (reqModel.includes("haiku")) {
    targetModel = "gemini-2.5-flash";
  } else if (reqModel.includes("opus")) {
    targetModel = "gemini-3.1-pro-preview";
  } else if (reqModel.includes("fable")) {
    targetModel = "gemini-3.1-flash-lite";
  }
  
  return {
    project: projectId,
    model: targetModel,
    request: {
      contents: mergedContents,
      systemInstruction,
      generationConfig,
      tools
    },
    userAgent: "pi-coding-agent",
    requestId: `pi-${Date.now()}`
  };
}

const server = http.createServer(async (req, res) => {
  console.log(`[Proxy] Incoming request: ${req.method} ${req.url}`);
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/v1' || pathname === '/v1/' || pathname === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === 'GET' && pathname.includes('/models')) {
    const parts = pathname.split('/');
    const modelsIndex = parts.indexOf('models');
    if (modelsIndex !== -1 && parts.length > modelsIndex + 1) {
      const modelId = parts.slice(modelsIndex + 1).join('/');
      console.log(`[Proxy] Mocking single model info for: ${modelId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: "model",
        id: modelId,
        display_name: modelId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
        created_at: "2026-04-08T00:00:00Z"
      }));
    } else {
      console.log(`[Proxy] Mocking model list`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          {
            type: "model",
            id: "claude-3-5-sonnet-20241022",
            display_name: "Claude 3.5 Sonnet (Gemini 2.5 Pro)",
            created_at: "2024-10-22T00:00:00Z"
          },
          {
            type: "model",
            id: "claude-3-5-haiku-20241022",
            display_name: "Claude 3.5 Haiku (Gemini 2.5 Flash)",
            created_at: "2024-10-22T00:00:00Z"
          },
          {
            type: "model",
            id: "claude-3-opus-20240229",
            display_name: "Claude 3 Opus (Gemini 3.1 Pro Preview)",
            created_at: "2024-02-29T00:00:00Z"
          },
          {
            type: "model",
            id: "claude-fable-5",
            display_name: "Claude Fable 5 (Gemini 3.1 Flash Lite)",
            created_at: "2026-06-30T00:00:00Z"
          }
        ],
        has_more: false,
        first_id: "claude-3-5-sonnet-20241022",
        last_id: "claude-fable-5"
      }));
    }
    return;
  }

  if (req.method === 'POST' && pathname.endsWith('/messages')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    
    req.on('end', async () => {
      try {
        const anthropicReq = JSON.parse(body);
        console.log(`[Proxy] Received messages request for model: ${anthropicReq.model}, stream: ${anthropicReq.stream}`);
        
        const { accessToken, projectId } = await getOrRefreshAccessToken();
        const { geminiModel, geminiFallbackModel } = getModelConfig();
        const geminiReq = mapAnthropicRequestToGemini(anthropicReq, projectId, geminiModel);
        
        let attempt = 0;
        let response;
        let currentModel = geminiReq.model;
        
        while (attempt < 3) {
          geminiReq.model = currentModel;
          response = await fetch('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream'
            },
            body: JSON.stringify(geminiReq)
          });
          
          if (response.status === 429) {
            // First retry fallback if using primary pro model and fallback is configured differently
            if (currentModel === geminiModel && geminiModel !== geminiFallbackModel) {
              console.warn(`[Proxy] Model ${currentModel} hit 429 rate limit. Retrying with fallback: ${geminiFallbackModel}...`);
              currentModel = geminiFallbackModel;
              attempt++;
              continue;
            }
            
            // Otherwise parse sleep duration from error response
            const errText = await response.clone().text();
            let waitSec = 5;
            try {
              const match = errText.match(/reset after (\d+)s/i);
              if (match) {
                waitSec = parseInt(match[1], 10) + 1;
              }
            } catch (e) {}
            
            console.warn(`[Proxy] Quota exhausted (429) on ${currentModel}. Sleeping for ${waitSec}s (attempt ${attempt + 1}/3)...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            attempt++;
            continue;
          }
          
          break; // Success or non-429 error
        }
        
        if (!response.ok) {
          const errText = await response.text();
          console.error("[Proxy] Code Assist API error:", response.status, errText);
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Google Code Assist error: ${errText}` } }));
          return;
        }
        
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        const messageId = `msg_gemini_${Math.random().toString(36).slice(2, 11)}`;
        res.write(`event: message_start\n`);
        res.write(`data: ${JSON.stringify({
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            content: [],
            model: anthropicReq.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        })}\n\n`);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let blockIndex = 0;
        let activeBlockType = null;
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr) continue;
            
            let chunk;
            try {
              chunk = JSON.parse(jsonStr);
            } catch (e) {
              continue;
            }
            
            const candidate = chunk.response?.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.text !== undefined) {
                  if (activeBlockType !== "text") {
                    if (activeBlockType === "tool_use") {
                      res.write(`event: content_block_stop\n`);
                      res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                      blockIndex++;
                    }
                    res.write(`event: content_block_start\n`);
                    res.write(`data: ${JSON.stringify({
                      type: "content_block_start",
                      index: blockIndex,
                      content_block: { type: "text", text: "" }
                    })}\n\n`);
                    activeBlockType = "text";
                  }
                  
                  res.write(`event: content_block_delta\n`);
                  res.write(`data: ${JSON.stringify({
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: { type: "text_delta", text: part.text }
                  })}\n\n`);
                }
                
                if (part.functionCall) {
                  if (activeBlockType === "text") {
                    res.write(`event: content_block_stop\n`);
                    res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                    blockIndex++;
                  }
                  
                  // Encode the thoughtSignature inside the generated toolUseId if present in Gemini response
                  let toolUseId = `toolu_${part.functionCall.name}_${Math.random().toString(36).slice(2, 9)}`;
                  if (candidate.thoughtSignature) {
                    const encodedSig = Buffer.from(candidate.thoughtSignature).toString('base64url');
                    toolUseId += `_sig_${encodedSig}`;
                  }
                  
                  res.write(`event: content_block_start\n`);
                  res.write(`data: ${JSON.stringify({
                    type: "content_block_start",
                    index: blockIndex,
                    content_block: {
                      type: "tool_use",
                      id: toolUseId,
                      name: part.functionCall.name,
                      input: {}
                    }
                  })}\n\n`);
                  
                  res.write(`event: content_block_delta\n`);
                  res.write(`data: ${JSON.stringify({
                    type: "content_block_delta",
                    index: blockIndex,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(part.functionCall.args || {})
                    }
                  })}\n\n`);
                  
                  res.write(`event: content_block_stop\n`);
                  res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                  blockIndex++;
                  activeBlockType = null;
                }
              }
            }
          }
        }
        
        if (activeBlockType === "text") {
          res.write(`event: content_block_stop\n`);
          res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
        }
        
        res.write(`event: message_delta\n`);
        res.write(`data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 }
        })}\n\n`);
        
        res.write(`event: message_stop\n`);
        res.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        
        res.end();
        console.log(`[Proxy] Finished streaming request: ${messageId}`);
      } catch (err) {
        console.error("[Proxy] Error handling request:", err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: "Not Found" } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Proxy] Local Claude-to-Gemini translation server listening on http://127.0.0.1:${PORT}`);
});
