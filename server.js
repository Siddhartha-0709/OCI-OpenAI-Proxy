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
 *
 * FIXES IN THIS VERSION:
 * 1. sanitizeSchemaForGemini() - strips $schema/additionalProperties/etc and
 *    coerces array-valued "type" (e.g. ["string","number","boolean"]) down to
 *    a single type, since Gemini's function-calling schema only supports a
 *    narrow JSON-Schema subset and rejects unknown keys / union types.
 * 2. Empty-content guard on the plain message branch - some backends
 *    (confirmed on OpenAI-hosted GPT-OSS-120B via OCI) reject any input item
 *    with content === "" ("Message content cannot be empty"), where Gemini
 *    silently tolerated it. We now skip pushing empty-content items instead
 *    of forwarding them.
 * 3. Same empty-content guard applied to function_call_output (tool result)
 *    content, and to the assistant tool_calls branch's trailing content push.
 */

const express = require('express');
const { randomUUID } = require('crypto');
require('dotenv').config();
const app = express();
app.use(express.json({ limit: '20mb' }));


// ---------------------------------------------------------------------------
// Config - set these via environment variables, do NOT hardcode secrets
// ---------------------------------------------------------------------------
const OCI_BASE_URL = process.env.OCI_BASE_URL;
const OCI_API_KEY = process.env.OCI_API_KEY;
const OCI_PROJECT_ID = process.env.OCI_PROJECT_ID;
const PORT = process.env.PORT;


if (!OCI_API_KEY || !OCI_PROJECT_ID || !OCI_BASE_URL || !PORT) {
  console.error(
    'FATAL: One or more required environment variables are missing.'
  );
  process.exit(1);
}

app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// ---------------------------------------------------------------------------
// Helper: is this content value "empty" in a way that will get an input item
// rejected by strict backends (GPT-OSS via OCI rejects content === "")?
// ---------------------------------------------------------------------------
function isEmptyContent(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Helper: sanitize a JSON Schema object so it validates against Gemini's
// function-calling tool schema (a restricted JSON-Schema subset). Strips
// unsupported keywords ($schema, additionalProperties, default, minimum,
// maximum, etc.) and coerces array-valued "type" down to a single string
// type (Gemini has no concept of a union type).
// ---------------------------------------------------------------------------
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'description', 'enum', 'items', 'properties', 'required',
  'format', 'nullable',
]);

function sanitizeSchemaForGemini(schema) {
  if (schema === null || typeof schema !== 'object') return schema;

  if (Array.isArray(schema)) {
    return schema.map(sanitizeSchemaForGemini);
  }

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue; // drop $schema, additionalProperties, default, minimum, etc.

    if (key === 'type') {
      if (Array.isArray(value)) {
        const nonNull = value.filter((t) => t !== 'null');
        out.type = nonNull[0] || value[0] || 'string';
        if (value.includes('null')) out.nullable = true;
      } else {
        out.type = value;
      }
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const cleanedProps = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        cleanedProps[propName] = sanitizeSchemaForGemini(propSchema);
      }
      out.properties = cleanedProps;
      continue;
    }

    if (key === 'items') {
      out.items = sanitizeSchemaForGemini(value);
      continue;
    }

    out[key] = value;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers: translate Chat Completions request -> Responses API request
// ---------------------------------------------------------------------------

// Convert a Chat Completions content value (string OR array-of-parts)
// into the shape the Responses API expects for a given role.
function toResponsesContent(content, role) {
  if (content == null) return content;

  if (typeof content === 'string') return content;

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
      const rawOutput =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      // Guard against an empty tool result string - some backends reject
      // empty content anywhere in input, including function_call_output.
      const output = isEmptyContent(rawOutput) ? '(no output)' : rawOutput;

      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output,
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
      // Only attach a trailing assistant content item if there's real
      // (non-empty) content - an assistant turn that's pure tool_calls
      // should not also push a { role: 'assistant', content: '' } item.
      if (!isEmptyContent(msg.content)) {
        input.push({
          role: 'assistant',
          content: toResponsesContent(msg.content, 'assistant'),
        });
      }
    } else {
      const converted = toResponsesContent(msg.content, msg.role);
      // Skip pushing messages with empty content entirely rather than
      // forwarding { role, content: "" } / { role, content: [] }, which
      // GPT-OSS-120B (and possibly other OCI-hosted models) reject with
      // "Message content cannot be empty".
      if (!isEmptyContent(converted)) {
        input.push({ role: msg.role, content: converted });
      }
    }
  }

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
      parameters: sanitizeSchemaForGemini(t.function.parameters),
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

  const toolCallIndexByCallId = new Map();
  let nextToolCallIndex = 0;

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
      return;
    }

    switch (evt.type) {
      case 'response.output_text.delta': {
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
        break;
    }
  }

  const reader = ociResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) processLine(line);
    }
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

      // TEMP DEBUG — remove once fixed
      console.log('--- Raw OCI response ---');
      console.log(JSON.stringify(result, null, 2));
      console.log('------------------------');

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