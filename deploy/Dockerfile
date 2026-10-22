# 旧布局专用；apps/packages 布局由构建脚本选择 Dockerfile.workspace。
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production \
    RUYI_LOGIN_DISPLAY=vnc \
    DISPLAY=:99 \
    RUYI_UPLOAD_DIR=/data/upload \
    RUYI_HEADLESS=1
WORKDIR /app
USER root
# 保留发行版、组件和签名密钥，仅切换官方 HTTPS 地址，避免 Azure 镜像源停滞。
RUN set -eu; \
    for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
        [ -f "$source" ] || continue; \
        sed -i -E \
            -e 's|https?://(azure\.)?archive\.ubuntu\.com/ubuntu/?|https://archive.ubuntu.com/ubuntu/|g' \
            -e 's|http://security\.ubuntu\.com/ubuntu/?|https://security.ubuntu.com/ubuntu/|g' \
            -e 's|http://ports\.ubuntu\.com/ubuntu-ports/?|https://ports.ubuntu.com/ubuntu-ports/|g' \
            "$source" || exit 1; \
    done \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 \
        -o APT::Update::Error-Mode=any update \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 \
        install -y --no-install-recommends xvfb x11-utils openbox x11vnc util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --include=dev
COPY . .
RUN npm run build:web \
    && mkdir -p /data/upload \
    && chown pwuser:pwuser /data/upload \
    && chmod 755 /app/scripts/start-desktop.sh
USER pwuser
EXPOSE 5173
ENTRYPOINT ["/app/scripts/start-desktop.sh"]
