import OpenAI from 'openai';

/**
 * The one provider seam for the xAI Responses coding loop.
 *
 * The loop depends on this interface, never on the SDK directly, so
 * deterministic protocol tests can script provider behavior. The real
 * transport dials https://api.x.ai/v1 with store:false, preserves every
 * output item (including reasoning) for the next turn, and NEVER retries:
 * hidden retries would repeat uncertain paid operations.
 */

export const XAI_BASE_URL = 'https://api.x.ai/v1';
/** The OpenAI SDK retries failures by default; Ranger forbids hidden retries. */
const SDK_MAX_RETRIES = 0;
const SDK_TIMEOUT_MS = 300_000;

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ResponsesCall {
  model: string;
  /** Full conversation items: prior outputs (reasoning preserved) plus tool outputs. */
  input: unknown[];
  /** Flat function tools: { type: 'function', name, description, parameters }. */
  tools: Array<Record<string, unknown>>;
  instructions?: string;
  maxOutputTokens?: number;
}

export interface ResponsesResult {
  output: Array<Record<string, unknown>>;
  usage: ProviderUsage | null;
  responseId: string | null;
}

export interface ResponsesTransport {
  create(call: ResponsesCall): Promise<ResponsesResult>;
}

export class OpenAiResponsesTransport implements ResponsesTransport {
  private readonly client: OpenAI;

  constructor(apiKey: string, baseUrl: string = XAI_BASE_URL) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: SDK_MAX_RETRIES, timeout: SDK_TIMEOUT_MS });
  }

  async create(call: ResponsesCall): Promise<ResponsesResult> {
    const response = await this.client.responses.create({
      model: call.model,
      input: call.input as OpenAI.Responses.ResponseInput,
      tools: call.tools as never,
      store: false,
      ...(call.instructions !== undefined ? { instructions: call.instructions } : {}),
      ...(call.maxOutputTokens !== undefined ? { max_output_tokens: call.maxOutputTokens } : {}),
    });
    return {
      output: (response.output ?? []) as unknown as Array<Record<string, unknown>>,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : null,
      responseId: response.id ?? null,
    };
  }
}
