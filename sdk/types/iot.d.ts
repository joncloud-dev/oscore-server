// Type declarations for the curated $iot global that the iotcore binary installs
// into every pb_hooks / pb_migrations JS runtime (see jsvm OnInit). Drop this
// alongside the PocketBase-generated pb_data/types.d.ts for editor autocomplete
// in your extension code.
//
// $iot is the closed core's small, safe API surface. It never returns raw OSCORE
// key material except from provisionDevice (the same server-generated path as
// the superuser HTTP endpoint), and never accepts key material from JS.

declare namespace iot {
  interface ProvisionResult {
    hw_id: string;
    sender_id: string;
    recipient_id: string;
    master_secret: string;
    master_salt: string;
    alg: string;
  }

  interface DeviceProfile {
    id: string;
    name: string;
    platform: string;
    keys: Record<string, string>;
    metrics: Array<{ key: string; name: string; label: string; unit: string }>;
  }

  /**
   * A hardware platform as data. In every array the index is the wire code
   * (the bit position, for hwCauseBits). Unknown fields are rejected.
   */
  interface PlatformSpec {
    /** Matches ^[a-z0-9][a-z0-9-]{0,47}$, unique across compiled-in and pb_hooks platforms. */
    name: string;
    /** Check-in transport wire code -> devices.transport value ("wifi", "ethernet", ...). */
    transports: Record<number, string>;
    /** Boot-report reboot-reason enum -> device_resets.reason value. */
    resetReasons: string[];
    /** Hardware reset-cause bitmap labels. */
    hwCauseBits?: string[];
    /** Fatal-fault enum labels (crash_reports.fault_type). */
    faultTypes?: string[];
    /** firmware_images.type value -> FOTA notice wire code, in listing order. */
    imageTypes?: Record<string, number>;
    /** Device-info CBOR sub-key -> devices column. */
    deviceInfoFields?: Record<string, "board" | "modem_fw" | "imei" | "iccid">;
    /** Bits cleared from a code address before symbol lookup (1 = ARM Thumb). */
    codeAddrClearMask?: number;
    /** A compiled-in A-GNSS wire contract ("nrf-modem"); omit for no GNSS assistance. */
    agnss?: "nrf-modem";
  }

  /** The argument of a $iot.codec handler: one POST /t body and its device. */
  interface UplinkInput {
    device: { id: string; hwId: string; profile: string; platform: string };
    /**
     * The request's Content-Format: "text" (also when the option is absent),
     * "octets", "json", "cbor", "senml+json", "senml+cbor", or the number as a
     * string for any other.
     */
    format: string;
    /** The body bytes (a copy). */
    buffer: ArrayBuffer;
    /** The body as UTF-8. */
    text(): string;
    /** JSON.parse of the body; throws (answering 4.00) on malformed JSON. */
    json(): any;
    /**
     * The body decoded as one CBOR item: maps with text keys become objects,
     * byte strings ArrayBuffers. Throws (answering 4.00) on malformed CBOR,
     * trailing bytes, or a map key that is not a text string.
     */
    cbor(): any;
  }

  type CoapMethod = "GET" | "POST" | "PUT" | "DELETE";

  /** Response status names; each maps to one CoAP code. */
  type CoapStatus =
    | "content" // 2.05
    | "changed" // 2.04
    | "created" // 2.01
    | "deleted" // 2.02
    | "valid" // 2.03
    | "badRequest" // 4.00
    | "unauthorized" // 4.01
    | "forbidden" // 4.03
    | "notFound" // 4.04
    | "notAcceptable" // 4.06
    | "preconditionFailed" // 4.12
    | "requestEntityTooLarge" // 4.13
    | "unsupportedMediaType" // 4.15
    | "tooManyRequests" // 4.29
    | "serviceUnavailable"; // 5.03

  type CoapFormat = "text" | "octets" | "json" | "cbor" | "senml+json" | "senml+cbor";

  /** The argument of a $iot.coapRoute handler: one OSCORE-verified request. */
  interface CoapRequest {
    /** The device OSCORE authenticated; never taken from the payload or URI. */
    device: { id: string; kid: string; hwId: string; profile: string; platform: string };
    method: CoapMethod;
    /** The registered path, e.g. "/cmd/ack". */
    path: string;
    /** Uri-Query options split at the first "="; a repeated key keeps the last value. */
    query: Record<string, string>;
    /**
     * The request's Content-Format name (as UplinkInput.format), or null when
     * the request carries no Content-Format option.
     */
    format: string | null;
    /** False for a NON request: the handler runs, the device gets no response. */
    confirmable: boolean;
    /** The body bytes (a copy). */
    buffer: ArrayBuffer;
    /** The body as UTF-8. */
    text(): string;
    /** JSON.parse of the body; a throw you do not catch answers 5.00. */
    json(): any;
    /** The body as one CBOR item (see UplinkInput.cbor); an uncaught throw answers 5.00. */
    cbor(): any;
  }

  /**
   * What a route handler returns; undefined means `{}`. Unknown fields and
   * null are rejected (5.00).
   */
  interface CoapResponse {
    /**
     * Default: "content" for GET, "changed" for POST and PUT, "deleted" for
     * DELETE.
     */
    status?: CoapStatus;
    /**
     * A string is sent as UTF-8 (default format "text"), an ArrayBuffer or
     * Uint8Array verbatim (default "octets"), and anything else is encoded as
     * CBOR (default "cbor") or as JSON when format is "json" or "senml+json".
     * Omit it for an empty body.
     */
    body?: unknown;
    format?: CoapFormat;
  }

  interface RouteOptions {
    /**
     * The largest encoded response body in bytes, 1 to 1024, default 256. A
     * larger body answers 5.00 and records a device.route_oversize security
     * event; the server has no Block2.
     */
    maxBody?: number;
  }

  /**
   * What a codec returns. Every field is optional and unknown fields are
   * rejected. A field set to undefined is skipped.
   */
  interface Uplink {
    /** Reading time as epoch seconds or a Date; default the receive time. */
    time?: number | Date;
    fwVersion?: string;
    /**
     * A transport value of the device's platform (e.g. "wifi"); anything else
     * answers 4.00. Default the device's stored transport.
     */
    transport?: string;
    /**
     * Metric NAME -> number. Every name must be in the profile's metrics
     * registry; the reading is stored under that metric's key.
     */
    metrics?: Record<string, number>;
    location?: { lat: number; lon: number; accuracy?: number; alt?: number };
    deviceInfo?: { board?: string; modemFw?: string; imei?: string; iccid?: string };
    /** JSON-encodable values kept verbatim under telemetry.data.x. */
    extra?: Record<string, unknown>;
  }
}

interface IotApi {
  /** Mint a device + fresh OSCORE context; returns plaintext material once. */
  provisionDevice(hwId?: string, senderId?: string, transport?: string): iot.ProvisionResult;
  /** Resolve a device's profile (wire keys, platform, metric registry). Throws while pb_hooks load. */
  deviceProfile(deviceId: string): iot.DeviceProfile;
  /** Set a device's desired shadow state and bump its version. */
  publishShadowDesired(deviceId: string, state: Record<string, unknown>): void;
  /**
   * Register a hardware platform. Call it at a pb_hooks file's top level: an
   * invalid spec or a taken name fails boot naming the file, and a call from a
   * handler throws because the set is sealed once pb_hooks have loaded.
   */
  platform(spec: iot.PlatformSpec): void;
  /**
   * Names of every hardware platform (compiled-in and pb_hooks), sorted. Throws
   * while pb_hooks load; call it from a handler.
   */
  platforms(): string[];
  /**
   * Register an uplink codec. A profile whose `codec` is `name` decodes every
   * POST /t body with `fn` instead of iot-cbor; profiles without one never
   * touch JS. Same top-level-only rule as platform(); pb_migrations may not
   * call it.
   *
   * `fn` is compiled from its source and runs in the $iot runtime pool, so it
   * sees its argument and the globals ($iot, $app, require, ...) but not the
   * hook file's top-level variables. Write it as `function (input) { ... }`
   * or `(input) => { return ... }`; `(input) => ({ ... })`, method shorthand,
   * async and generator functions are rejected at boot.
   *
   * It runs before the uplink transaction. Treat $app as read-only here: a
   * write is not part of the uplink's transaction.
   *
   * Return an Uplink, or null for a valid payload with nothing to store (only
   * last_seen advances). Returning undefined, an invalid Uplink or throwing
   * answers the device 4.00 and logs the reason. A call that runs past its
   * budget (250ms) is interrupted, and a call that finds the pool busy for
   * 250ms is shed; both answer 5.03 with Max-Age 2.
   */
  codec(name: string, fn: (input: iot.UplinkInput) => iot.Uplink | null): void;
  /**
   * Serve an operator CoAP resource on the OSCORE-protected device port.
   * Same top-level-only and function-source rules as codec(); pb_migrations
   * may not call it. Registration fails boot naming the file for an unknown
   * method, a malformed path (1 to 8 segments of [A-Za-z0-9._~-], no "." or
   * ".."), a reserved path, a method and path already registered, or a bad
   * maxBody.
   *
   * Reserved: any path whose first segment is one character (the core's
   * resources and their future siblings), and the first segments "hello",
   * "time" and ".well-known".
   *
   * A request without a valid OSCORE context answers 4.01 before any JS runs.
   * A method with no handler on a registered path answers 4.05. A throw or an
   * invalid return value answers 5.00 and logs the reason. A call that runs
   * past its budget (1s) is interrupted, and a call that finds no free
   * runtime for 250ms is shed; both answer 5.03 with Max-Age 2. Route calls
   * use at most half the pool's runtimes, so a spinning route cannot starve
   * codec ingest on /t.
   *
   * Responses carry no queue-mode envelope flags (shadow or FOTA pending);
   * devices learn those from their /t check-in.
   */
  coapRoute(
    method: iot.CoapMethod,
    path: string,
    fn: (req: iot.CoapRequest) => iot.CoapResponse | undefined,
    opts?: iot.RouteOptions,
  ): void;
}

declare var $iot: IotApi;
