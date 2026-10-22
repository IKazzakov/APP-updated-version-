import { createDataClient } from '../data-client.js';
import { ApiError } from '../api.js';
import { parseReply } from '../shared/contracts/validate.ts';
import type { ApiRequest, Transport } from '../shared/contracts/api.ts';
export function createApiClient(transport: Transport) {
  const client = createDataClient(transport);
  const request: ApiRequest = async (path, options) => {
    const result = await client.request(path, options);
    try {
      return parseReply(path, result);
    } catch {
      throw new ApiError('API_RESPONSE_INVALID', 200);
    }
  };
  return {
    request,
    get compact() {
      return client.compact;
    },
  };
}
