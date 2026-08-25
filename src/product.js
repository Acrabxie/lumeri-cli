export const VIDEO_PRODUCT = "video";
export const QUANTA_PRODUCT = "quanta";

export function normalizeProduct(value) {
  return String(value || "").trim().toLowerCase() === QUANTA_PRODUCT
    ? QUANTA_PRODUCT
    : VIDEO_PRODUCT;
}

export function currentProduct(env = process.env) {
  return normalizeProduct(env.LUMERI_PRODUCT);
}

export function commandNameForProduct(product) {
  return normalizeProduct(product) === QUANTA_PRODUCT ? "luqu" : "luvi";
}

export function productLabelForProduct(product) {
  return normalizeProduct(product) === QUANTA_PRODUCT ? "Quanta" : "Video";
}
