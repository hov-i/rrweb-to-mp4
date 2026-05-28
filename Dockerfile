# Microsoft 공식 Playwright 이미지 = Chromium + 시스템 의존성 + Node 20 미리 설치됨.
# 태그는 실제로 설치되는 playwright 버전과 정확히 일치해야 함 (Chromium 빌드 ID가 버전마다 다름).
# 확인: `npm ls playwright` 또는 node_modules/playwright/package.json
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

# 세그먼트 변환 후 ffmpeg concat / -ss trim 에 사용. Playwright 이미지에 ffmpeg가
# 번들돼 있긴 하나 PATH 안정성을 위해 명시적으로 설치.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# 이미지에 Chromium이 이미 들어있으므로 rrvideo의 postinstall(`playwright install`)이
# 또 받지 않게 --ignore-scripts 로 차단. 런타임은 이미지 기본 브라우저를 그대로 사용.
RUN npm ci --omit=dev --ignore-scripts

COPY . .

ENV NODE_ENV=production
# Railway는 PORT 환경변수를 주입하고, server.mjs:11 이 이미 그걸 읽음.
EXPOSE 3000

CMD ["node", "server.mjs"]
