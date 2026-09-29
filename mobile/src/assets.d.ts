// Static image assets bundled by Metro: an import resolves to the asset registry id that
// <Image source={...}> takes (the ES-module form of require("./x.webp")).
declare module "*.webp" {
  const asset: number;
  export default asset;
}
