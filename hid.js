/** WebHID + USB Serial to RP2040 (Mouse HID + command channel). */

const SESSION_KEY = "fracture_hid_session";

/** Must match firmware USB_PRODUCT / fracture_token.h (max 31 chars — USB core limit). */
export const FRACTURE_USB_TOKEN = "oFbFVKkjWDhgUav5QPfMCJ4q8NHJ4Lr";

/** Raspberry Pi / earlephilhower Pico VID */
const PICO_VID = 0x2e8a;

const TOKEN_MIN_LEN = 24;

/** @type {HIDDevice | null} */
let hidDevice = null;
/** @type {SerialPort | null} */
let serialPort = null;
/** @type {WritableStreamDefaultWriter<Uint8Array> | null} */
let serialWriter = null;

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  void closeSerial();
  hidDevice = null;
}

export function requireSessionOrRedirect() {
  if (!getSession()) {
    location.replace("./index.html");
    return false;
  }
  return true;
}

export function hidSupported() {
  return typeof navigator !== "undefined" && !!navigator.hid;
}

export function serialSupported() {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

export function looksLikeToken(name) {
  if (!name || typeof name !== "string") return false;
  const s = name.trim();
  if (s.length < TOKEN_MIN_LEN) return false;
  const low = s.toLowerCase();
  if (
    low.includes("pico") ||
    low === "mouse" ||
    low.includes("gaming mouse") ||
    low.includes("lilygo")
  ) {
    return false;
  }
  return /^[A-Za-z0-9_-]+$/.test(s);
}

export function isFractureToken(name) {
  return (name || "").trim() === FRACTURE_USB_TOKEN;
}

function maskToken(t) {
  if (!t || t.length < 10) return t || "—";
  return `${t.slice(0, 4)}***${t.slice(-4)}`;
}

async function closeSerial() {
  try {
    serialWriter?.releaseLock();
  } catch {
    /* ignore */
  }
  serialWriter = null;
  try {
    await serialPort?.close();
  } catch {
    /* ignore */
  }
  serialPort = null;
}

async function openSerialPort(port) {
  if (!port) return false;
  if (!port.readable && !port.writable) {
    await port.open({ baudRate: 115200 });
  } else if (!port.writable) {
    await port.open({ baudRate: 115200 });
  }
  serialPort = port;
  serialWriter = port.writable.getWriter();
  return true;
}

/** Prefer already-permitted Pico serial; else native picker (call from click). */
export async function connectSerial({ requestIfNeeded = true } = {}) {
  if (!serialSupported()) {
    throw new Error("Web Serial niedostępne — Chrome / Edge.");
  }
  await closeSerial();

  const granted = await navigator.serial.getPorts();
  let port =
    granted.find((p) => {
      const i = p.getInfo?.() || {};
      return i.usbVendorId === PICO_VID;
    }) || null;

  if (!port && requestIfNeeded) {
    port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: PICO_VID }],
    });
  }
  if (!port) return false;
  return openSerialPort(port);
}

export function serialConnected() {
  return !!(serialPort && serialWriter);
}

async function writeFrame(bytes) {
  if (!serialWriter) return false;
  try {
    await serialWriter.write(bytes);
    return true;
  } catch (e) {
    console.warn("serial write failed", e);
    await closeSerial();
    return false;
  }
}

/**
 * Opens HID picker (auth/token) then Serial (mouse commands to RP2040).
 */
export async function loginWithHid({ softAccept = false } = {}) {
  if (!hidSupported()) {
    throw new Error("WebHID niedostępne — użyj Chrome / Edge / Opera (HTTPS lub localhost).");
  }

  const devices = await navigator.hid.requestDevice({
    filters: [{ vendorId: PICO_VID }],
  });

  if (!devices || !devices.length) {
    throw new Error(
      "Nie wybrano urządzenia. Wgraj firmware z Mouse + USB_PRODUCT=token, " +
        "potem w pickerze wybierz długi string (nie klawiaturę / mysz)."
    );
  }

  const device = devices[0];
  const productName = (device.productName || "").trim();
  const tokenOk = isFractureToken(productName);

  if (!tokenOk && !softAccept) {
    const hint = looksLikeToken(productName)
      ? "Inny token — to nie ta płytka."
      : `Nazwa: "${productName || "pusta"}" — oczekiwany token z firmware.`;
    throw new Error(`Logowanie odrzucone. ${hint}`);
  }

  if (device.vendorId !== PICO_VID && !softAccept) {
    throw new Error("To nie jest urządzenie Pico / T-PicoC3.");
  }

  if (!device.opened) {
    await device.open();
  }
  hidDevice = device;

  // Command channel — same USB composite CDC as Mouse HID
  try {
    await connectSerial({ requestIfNeeded: true });
  } catch (e) {
    console.warn("serial connect", e);
    throw new Error(
      "HID OK, ale wybierz też port Serial Pico (ten sam USB) — bez tego trigger/aim nie wyśle klików."
    );
  }

  const token = tokenOk
    ? productName
    : productName ||
      device.serialNumber ||
      `hid-${device.vendorId}-${device.productId}`;

  const session = {
    token,
    tokenMasked: maskToken(token),
    productName,
    vendorId: device.vendorId,
    productId: device.productId,
    at: Date.now(),
    soft: !tokenOk,
    serial: serialConnected(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { device, session, serial: serialConnected() };
}

export async function reconnectPaired() {
  if (!hidSupported()) return null;
  const list = await navigator.hid.getDevices();
  const session = getSession();
  if (!session || !list.length) return null;
  const match =
    list.find(
      (d) =>
        isFractureToken(d.productName) ||
        d.productName === session.productName ||
        (d.vendorId === session.vendorId && d.productId === session.productId)
    ) || null;
  if (!match) return null;
  if (!isFractureToken(match.productName) && !session.preview && !session.soft) {
    return null;
  }
  if (!match.opened) await match.open();
  hidDevice = match;

  try {
    await connectSerial({ requestIfNeeded: false });
  } catch {
    /* user can reconnect via button later */
  }
  return match;
}

/** Relative mouse move via RP2040 Serial → Mouse.move */
export async function sendMove(_device, dx, dy) {
  if (!serialWriter) return false;
  let x = Math.round(dx);
  let y = Math.round(dy);
  // chunk into int8 steps
  while (x !== 0 || y !== 0) {
    const sx = Math.max(-127, Math.min(127, x));
    const sy = Math.max(-127, Math.min(127, y));
    const ok = await writeFrame(new Uint8Array([0x01, sx & 0xff, sy & 0xff]));
    if (!ok) return false;
    x -= sx;
    y -= sy;
  }
  return true;
}

/** Single tap via firmware 0x02 (press+short delay+release on device). */
export async function sendClick(_device, btn = 1) {
  const b = btn & 0xff;
  // one packet — avoids host setTimeout + multi-frame serial queue lag
  return writeFrame(new Uint8Array([0x02, b, 0x00]));
}

/** One-shot test: same path as trigger. */
export async function testClick() {
  return sendClick(null, 1);
}

export { maskToken, TOKEN_MIN_LEN };
