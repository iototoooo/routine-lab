import type { NextConfig } from "next";

// 静的エクスポート専用の設定（docs/plan.md 6章）。
// 禁止：cacheComponents / partialPrefetching（PPR）/ rewrites / redirects / headers / experimental 系。
// create-next-app 16.4.5 の既定値には cacheComponents と partialPrefetching が入っているが、
// 静的出力と組み合わせるとビルドが壊れる（課題①の教訓）ため削除している。
// scripts/check-static.mjs がこれらの再混入を検出する。
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
