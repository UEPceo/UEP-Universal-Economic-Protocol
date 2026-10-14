/**
 * @uep/iot-m2m — gateway client. The transport is supplied by the caller.
 * A drop is queued; the telemetry id is not sent twice.
 */
import { IoTGateway, assertTelemetrySchema } from "../../src/service/iot-gateway.ts";
import type { IoTTelemetry } from "../../src/service/iot-m2m.ts";

export class IotClient {
  readonly gateway: IoTGateway;
  constructor(send: (telemetry: IoTTelemetry) => void) {
    this.gateway = new IoTGateway(send);
  }
  submit(telemetry: IoTTelemetry, transportUp = true) {
    assertTelemetrySchema(telemetry);
    return this.gateway.submit(telemetry, transportUp);
  }
  flush(transportUp = true) {
    return this.gateway.flush(transportUp);
  }
}
