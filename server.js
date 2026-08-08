/**
 * OCI Generative AI -> OpenAI Chat Completions Compatibility Proxy
 * ------------------------------------------------------------------
 * Purpose: n8n's native "OpenAI Chat Model" node (used inside the AI Agent node)
 * only ever calls POST {baseURL}/chat/completions. OCI's OpenAI-compatible
 * /chat/completions endpoint accepts `tools` but silently ignores them for
 * non-OpenAI-hosted models (e.g. google.gemini-2.5-flash) - confirmed via
 * direct testing. Real tool/function calling on OCI only works through
 * POST {baseURL}/responses (the Responses API).
 *
 * This proxy sits between n8n and OCI:
 *   n8n (Chat Completions format) -> this proxy -> OCI /responses -> this proxy -> n8n
 *
 * Point n8n's "OpenAI Chat Model" credential Base URL at this proxy, e.g.:
 *   http://localhost:3000/v1
 * API Key field in n8n can be any placeholder string - this proxy injects the
 * real OCI Authorization + OpenAI-Project headers itself, server-side.
 */

const express = require('express');
const { randomUUID } = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));


// ---------------------------------------------------------------------------
// Config - set these via environment variables, do NOT hardcode secrets
// ---------------------------------------------------------------------------
const OCI_BASE_URL = 'https://inference.generativeai.ap-hyderabad-1.oci.oraclecloud.com/openai/v1';
const OCI_API_KEY = 'sk-qH51ybulromeKpLjSdQlOl78NqZMDg9opDSLX7BaCi7wAZn4';
const OCI_PROJECT_ID = 'ocid1.generativeaiproject.oc1.ap-hyderabad-1.amaaaaaayzl4usya54fovoscdd5ekgsc5smies4rmqtv6d2ed66mis3bzjuq'; // ocid1.generativeaiproject...
const PORT = process.env.PORT || 8888;

if (!OCI_API_KEY || !OCI_PROJECT_ID) {
  console.error(
    'FATAL: OCI_GENAI_API_KEY and OCI_GENAI_PROJECT_ID env vars are required.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers: translate Chat Completions request -> Responses API request
// ---------------------------------------------------------------------------

/**
 * Chat Completions `messages[]` roughly maps 1:1 onto Responses `input[]`.
 * Chat Completions `tools[].function.{name,description,parameters}` needs to be
 * flattened to Responses `tools[].{type:'function', name, description, parameters}`.
 */

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});



// ---------------------------------------------------------------------------
// Helpers: translate Responses API result -> Chat Completions result
// ---------------------------------------------------------------------------


// Convert a Chat Completions content value (string OR array-of-parts)
// into the shape the Responses API expects for a given role.
function toResponsesContent(content, role) {
  if (content == null) return content;

  // Plain string content is valid as-is for both APIs.
  if (typeof content === 'string') return content;

  // Array of content parts: translate Chat Completions part types
  // ("text", "image_url", "input_audio", ...) into Responses part types
  // ("input_text"/"output_text", "input_image", ...).
  if (Array.isArray(content)) {
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    return content.map((part) => {
      if (part.type === 'text') {
        return { type: textType, text: part.text };
      }
      if (part.type === 'image_url') {
        return {
          type: 'input_image',
          image_url: typeof part.image_url === 'string'
            ? part.image_url
            : part.image_url?.url,
        };
      }
      // Pass through anything already in Responses-native shape
      // (e.g. someone already sent input_text/input_image/output_text).
      return part;
    });
  }

  return content;
}
function chatCompletionsToResponses(body) {
  const {
    model,
    messages = [],
    tools,
    tool_choice,
    stream,
    temperature,
    max_tokens,
    previous_response_id,
  } = body;

  const input = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output:
          typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content),
      });
    } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      if (msg.content) {
        input.push({
          role: 'assistant',
          content: toResponsesContent(msg.content, 'assistant'),
        });
      }
    } else {
      input.push({
        role: msg.role,
        content: toResponsesContent(msg.content, msg.role),
      });
    }
  }

  // --- this part was missing entirely ---
  const responsesReq = {
    model,
    input,
    stream: !!stream,
  };

  if (previous_response_id) responsesReq.previous_response_id = previous_response_id;
  if (temperature !== undefined) responsesReq.temperature = temperature;
  if (max_tokens !== undefined) responsesReq.max_output_tokens = max_tokens;

  if (Array.isArray(tools) && tools.length > 0) {
    responsesReq.tools = tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      responsesReq.tool_choice = tool_choice;
    } else if (tool_choice?.function?.name) {
      responsesReq.tool_choice = {
        type: 'function',
        name: tool_choice.function.name,
      };
    }
  }

  return responsesReq;
  // --- end missing part ---
}

function responsesOutputToChatMessage(output = []) {
  const toolCalls = [];
  let textContent = '';

  for (const item of output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    } else if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') textContent += c.text;
      }
    }
  }

  const message = {
    role: 'assistant',
    content: textContent || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const finish_reason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  return { message, finish_reason };
}

function responsesResultToChatCompletion(result) {
  const { message, finish_reason } = responsesOutputToChatMessage(result.output);
  return {
    id: result.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: result.created_at || Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason,
      },
    ],
    usage: result.usage
      ? {
        prompt_tokens: result.usage.input_tokens,
        completion_tokens: result.usage.output_tokens,
        total_tokens: result.usage.total_tokens,
      }
      : undefined,
    // Non-standard field, harmless to pass through: lets a follow-up call
    // resume the same OCI conversation if the caller wants multi-turn state.
    _oci_response_id: result.id,
  };
}

// ---------------------------------------------------------------------------
// Streaming translation: OCI Responses SSE events -> Chat Completions SSE deltas
// ---------------------------------------------------------------------------

async function streamResponsesToChatCompletions(ociResponse, res, model) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const chatId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Track tool_call index -> whether we've already sent the "opening" delta
  // (id/type/function.name) for that call_id, so subsequent argument deltas
  // only send the incremental arguments string, matching OpenAI's wire format.
  const toolCallIndexByCallId = new Map();
  let nextToolCallIndex = 0;
  let sentAnyTextDelta = false;

  function sendChunk(delta, finish_reason = null) {
    const chunk = {
      id: chatId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  function processLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === '[DONE]') return;

    let evt;
    try {
      evt = JSON.parse(jsonStr);
    } catch {
      return; // ignore malformed partial event
    }

    switch (evt.type) {
      case 'response.output_text.delta': {
        sentAnyTextDelta = true;
        sendChunk({ content: evt.delta });
        break;
      }

      case 'response.output_item.added': {
        if (evt.item?.type === 'function_call') {
          const index = nextToolCallIndex++;
          toolCallIndexByCallId.set(evt.item.call_id, index);
          sendChunk({
            tool_calls: [
              {
                index,
                id: evt.item.call_id,
                type: 'function',
                function: { name: evt.item.name, arguments: '' },
              },
            ],
          });
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const index = toolCallIndexByCallId.get(evt.item_id) ?? 0;
        sendChunk({
          tool_calls: [{ index, function: { arguments: evt.delta } }],
        });
        break;
      }

      case 'response.completed': {
        const hadToolCalls = toolCallIndexByCallId.size > 0;
        sendChunk({}, hadToolCalls ? 'tool_calls' : 'stop');
        break;
      }

      case 'response.failed':
      case 'error': {
        sendChunk({}, 'stop');
        break;
      }

      default:
        // response.created, response.in_progress, response.output_item.done,
        // response.function_call_arguments.done - no Chat Completions equivalent needed
        break;
    }
  }

  // Node's built-in fetch() returns a Web Streams `ReadableStream` for
  // response.body (not a Node.js EventEmitter stream), so we must read it
  // via getReader() rather than .on('data', ...).
  const reader = ociResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last partial line for next chunk

      for (const line of lines) processLine(line);
    }
    // flush any trailing partial line
    if (buffer) processLine(buffer);
  } catch (err) {
    console.error('OCI stream read error:', err);
  } finally {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Route: POST /v1/chat/completions  (what n8n's OpenAI Chat Model node calls)
// ---------------------------------------------------------------------------

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const responsesReq = chatCompletionsToResponses(req.body);


    // TEMP DEBUG — remove once fixed
    console.log('--- Outgoing to OCI ---');
    console.log(JSON.stringify(responsesReq, null, 2));
    console.log('-----------------------');


    const ociRes = await fetch(`${OCI_BASE_URL}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OCI_API_KEY}`,
        'OpenAI-Project': OCI_PROJECT_ID,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(responsesReq),
    });

    if (!ociRes.ok) {
      const errBody = await ociRes.text();
      console.error('OCI error:', ociRes.status, errBody);
      return res.status(ociRes.status).json({
        error: {
          message: `OCI upstream error: ${errBody}`,
          type: 'upstream_error',
          code: ociRes.status,
        },
      });
    }

    if (req.body.stream) {
      await streamResponsesToChatCompletions(ociRes, res, req.body.model);
    } else {
      const result = await ociRes.json();
      const chatCompletion = responsesResultToChatCompletion(result);
      res.json(chatCompletion);
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({
      error: { message: err.message, type: 'proxy_internal_error' },
    });
  }
});

// ---------------------------------------------------------------------------
// Route: GET /v1/models  (some clients probe this before allowing a request)
// ---------------------------------------------------------------------------
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'google.gemini-2.5-flash', object: 'model', owned_by: 'oci' },
      { id: 'openai.gpt-oss-120b', object: 'model', owned_by: 'oci' },
    ],
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`OCI<->OpenAI proxy listening on port ${PORT}`);
  console.log(`n8n Base URL should be: http://<this-host>:${PORT}/v1`);
});