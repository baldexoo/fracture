import { hidSupported, loginWithHid } from "./hid.js?v=trig1";

// Strip leftover login clutter even if an old cached index.html loads.
for (const sel of [".login-logo", ".login-steps", ".login-hint"]) {
  document.querySelector(sel)?.remove();
}

const btn = document.getElementById("loginBtn");
const previewBtn = document.getElementById("previewBtn");
const err = document.getElementById("loginError");

btn.addEventListener("click", async () => {
  err.textContent = "";
  btn.disabled = true;
  try {
    if (!hidSupported()) {
      throw new Error("WebHID niedostępne w tej przeglądarce.");
    }
    await loginWithHid({ softAccept: false });
    location.href = "./panel.html?v=trig7";
  } catch (e) {
    err.textContent = e?.message || String(e);
  } finally {
    btn.disabled = false;
  }
});

previewBtn.addEventListener("click", () => {
  sessionStorage.setItem(
    "fracture_hid_session",
    JSON.stringify({
      token: "PREVIEW-NO-DEVICE",
      tokenMasked: "PRE***ICE",
      productName: "preview",
      vendorId: 0,
      productId: 0,
      at: Date.now(),
      soft: true,
      preview: true,
    })
  );
  location.href = "./panel.html?v=perf1";
});
