/**
 * Shared MCP response formatting helper.
 * Accepts a value or a Promise — always resolves before serialising.
 */
export async function jsonResult(obj, isError = false) {
  const data = await obj;
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    ...(isError && { isError: true }),
  };
}
