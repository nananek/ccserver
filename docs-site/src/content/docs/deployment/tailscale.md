---
title: Tailscale Serve で HTTPS 公開
description: Tailscale Serve を使って Tailnet 内から ccserver に HTTPS でアクセスする
---

Tailscale Serve を使うと、Tailnet 内のデバイスから HTTPS でアクセスできます。

## 1. ccserver が起動していることを確認

```bash
systemctl --user status ccserver
```

## 2. Tailscale Serve を設定

```bash
# ポート 3001 を HTTPS で公開
sudo tailscale serve --bg 3001
```

これにより `https://<hostname>.<tailnet>.ts.net/` でアクセス可能になります。

## 3. 確認

```bash
# 現在の serve 設定を表示
tailscale serve status
```

## 4. 停止

```bash
tailscale serve --https=443 off
```
