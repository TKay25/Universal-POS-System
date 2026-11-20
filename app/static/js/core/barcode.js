/* In-store EAN-13 numbering, mirroring app/services/barcode.py.

   A 13-digit code with a valid check digit prints as EAN-13, which is what every
   retail scanner expects. */

export function ean13CheckDigit(body) {
  let total = 0;
  for (let index = 0; index < body.length; index += 1) {
    total += Number(body[index]) * (index % 2 ? 3 : 1);
  }
  return String((10 - (total % 10)) % 10);
}

export function isEan13(code) {
  const value = String(code || "").trim();
  return value.length === 13 && /^\d{13}$/.test(value) && ean13CheckDigit(value.slice(0, 12)) === value[12];
}

/* GS1 reserves 20-29 for in-store codes, so these never clash with real products. */
export function newInStoreCode(taken = []) {
  const used = new Set((taken || []).map((code) => String(code || "").trim()));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let body = "20";
    for (let i = 0; i < 10; i += 1) body += String(Math.floor(Math.random() * 10));
    const code = body + ean13CheckDigit(body);
    if (!used.has(code)) return code;
  }
  return "";
}
