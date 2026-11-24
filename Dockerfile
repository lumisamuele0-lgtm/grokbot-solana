# GrokBot Solana — immagine per hosting cloud (HTTPS gestito dall'hosting)
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 HOST=0.0.0.0 \
    DATA_DIR=/data \
    IN_CONTAINER=1 TRUST_PROXY=1 FORCE_HTTPS=1 NO_QR=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
# /data va montata come volume persistente (wallet cifrato, PIN, stato, storico)
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
