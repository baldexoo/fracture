/** WebHID helper — USB only. No WiFi. Token = USB product string. */

const SESSION_KEY = "fracture_hid_session";

/** Must match firmware USB_PRODUCT / fracture_token.h (max 31 chars — USB core limit). */
export const FRACTURE_USB_TOKEN = "oFbFVKkjWDhgUav5QPfMCJ4q8NHJ4Lr";

/** Raspberry Pi / earlephilhower Pico VID */
const PICO_VID = 0x2e8a;

/** Min length for falli.ng-style token product name (not "Pico" / "Mouse"). */
const TOKEN_MIN_LEN = 24;

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
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

/** Exact match to this board's token — other HID devices fail login. */
export function isFractureToken(name) {
  return (name || "").trim() === FRACTURE_USB_TOKEN;
}

function maskToken(t) {
  if (!t || t.length < 10) return t || "—";
  return `${t.slice(0, 4)}***${t.slice(-4)}`;
}

/**
 * Opens native HID picker (Pico VID only). Firmware product string = login token.
 * softAccept: allow non-token devices (dev / preview only — not used by login).
 */
export async function loginWithHid({ softAccept = false } = {}) {
  if (!hidSupported()) {
    throw new Error("WebHID niedostępne — użyj Chrome / Edge / Opera (HTTPS lub localhost).");
  }

  const devices = await navigator.hid.requestDevice({
    filters: [{ vendorId: PICO_VID }],
    // Chrome may still list previously-granted non-Pico; we reject below.
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
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return { device, session };
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
  return match;
}

/** Relative mouse move — stub until custom HID output report exists. */
export async function sendMove(device, dx, dy) {
  if (!device) return;
  void dx;
  void dy;
}

export async function sendClick(device, btn = 1) {
  if (!device) return;
  void btn;
}

export { maskToken, TOKEN_MIN_LEN };
