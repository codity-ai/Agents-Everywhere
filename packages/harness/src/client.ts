import { request, type JsonResponse } from "./http"
import type {
  EventRequest,
  EventType,
  FinishStatus,
  HandshakeRequest,
  HandshakeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PermissionRequestAck,
  PermissionRequestBody,
  Usage,
} from "./protocol"

/** The five calls a runner makes, bound to one control plane and run token. */
export class RunnerClient {
  private authorization: string

  constructor(
    readonly apiUrl: string,
    runToken: string,
  ) {
    this.authorization = `Bearer ${runToken}`
  }

  static handshake(apiUrl: string, bootstrapToken: string, body: HandshakeRequest) {
    return request<HandshakeResponse>("POST", `${apiUrl}/agents/runtime/handshake`, body, {
      Authorization: `Bearer ${bootstrapToken}`,
    })
  }

  /** A run outlives a single token: the server hands out a fresh one before it expires. */
  replaceToken(runToken: string) {
    this.authorization = `Bearer ${runToken}`
  }

  heartbeat(body: HeartbeatRequest): Promise<JsonResponse<HeartbeatResponse>> {
    return request("POST", `${this.apiUrl}/agents/runtime/heartbeat`, body, this.headers())
  }

  postEvent(eventType: EventType, payload: Record<string, unknown>, usage: Usage = {}, eventId?: string) {
    const body: EventRequest = {
      ...(eventId !== undefined ? { event_id: eventId } : {}),
      event_type: eventType,
      payload,
      tokens_in: usage.tokensIn || 0,
      tokens_out: usage.tokensOut || 0,
      cost_usd: usage.costUsd ?? null,
    }
    return request("POST", `${this.apiUrl}/agents/runtime/events`, body, this.headers())
  }

  finish(status: FinishStatus, message: string) {
    return request("POST", `${this.apiUrl}/agents/runtime/finish`, { status, message }, this.headers())
  }

  raisePermissionRequest(body: PermissionRequestBody): Promise<JsonResponse<PermissionRequestAck>> {
    return request("POST", `${this.apiUrl}/agents/runtime/permission-requests`, body, this.headers())
  }

  private headers() {
    return { Authorization: this.authorization }
  }
}
