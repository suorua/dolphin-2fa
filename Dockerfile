FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

ENV TZ=Asia/Shanghai

WORKDIR /app

# 直接复制本地编译好的 Linux 二进制文件
COPY ./dist/dolphin-2fa /app/dolphin-2fa

RUN chmod +x /app/dolphin-2fa && mkdir -p /app/data

EXPOSE 8080

ENTRYPOINT ["/app/dolphin-2fa"]
CMD ["-host", "0.0.0.0", "-port", "8080", "-db", "/app/data/dolphin_2fa.db", "-trust-proxy", "-no-browser"]