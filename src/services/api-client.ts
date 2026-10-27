import { createDataClient } from '../data-client.js';
import { ApiError, markInvalidResponse } from '../api.js';
import { parseReply } from '../shared/contracts/validate.ts';
import type { ApiRequest, Transport } from '../shared/contracts/api.ts';
export function createApiClient(transport: Transport) {
  const client = createDataClient(transport);
  const request: ApiRequest = async (path, options) => {
    // Programs have no v1 fallback. The explicit v2 prefix must not be added twice.
    const result =
      path === 'v2/activity' || path.startsWith('v2/workouts/')
        ? await transport(path, options)
        : await client.request(path, options);
    try {
      return parseReply(path, result);
    } catch {
      markInvalidResponse();
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
