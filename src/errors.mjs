export class GatewayError extends Error {
  constructor(type, status = 502, message = type) {
    super(message);
    this.type = type;
    this.status = status;
  }
}
export const fail = (type, status, message) =>
  new GatewayError(type, status, message);
export function publicError(error) {
  return {
    error: {
      type: error.type || "gateway_error",
      message: error.type ? error.message : "upstream request failed",
    },
  };
}
