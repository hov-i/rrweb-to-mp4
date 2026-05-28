# Microsoft 공식 Playwright 이미지 = Chromium + 시스템 의존성 + Node 20 미리 설치됨.
# 태그는 package-lock의 rrvideo가 요구하는 playwright(^1.56.1)에 맞춤.
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

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
