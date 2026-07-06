import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // التطبيق يُخدم على fieldsa.net/portfolio عبر بروكسي من مشروع الواجهة
  basePath: "/portfolio",
  // تحويل الجذر إلى /portfolio عند الدخول المباشر لرابط Vercel
  async redirects() {
    return [{ source: "/", destination: "/portfolio", basePath: false, permanent: false }];
  },
  // تثبيت جذر المشروع لتجنّب اختيار Next لمجلّد خاطئ بسبب lockfiles متعددة
  outputFileTracingRoot: path.join(__dirname),
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
