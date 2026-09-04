// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages project page: https://nananek.github.io/ccserver/
	site: 'https://nananek.github.io',
	base: '/ccserver',
	integrations: [
		starlight({
			title: 'ccserver docs',
			description: 'Context & Coordination Server for browser-based AI CLI sessions',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/nananek/ccserver' }],
			defaultLocale: 'root',
			locales: {
				root: { label: '日本語', lang: 'ja' },
			},
			editLink: {
				baseUrl: 'https://github.com/nananek/ccserver/edit/master/docs-site/',
			},
			sidebar: [
				{
					label: 'はじめに',
					items: [
						{ label: '概要', slug: 'getting-started/overview' },
						{ label: '必要な環境', slug: 'getting-started/requirements' },
						{ label: 'インストールと起動', slug: 'getting-started/installation' },
					],
				},
				{
					label: 'ガイド',
					items: [
						{ label: '起動 (アプリ・サンドボックス)', slug: 'guides/launching' },
						{ label: '予約プロンプト (タイマー)', slug: 'guides/scheduled-prompts' },
						{ label: '通知 (ccserver-notify) と Vikunja 連携', slug: 'guides/notify' },
						{ label: '使用量 (Usage)', slug: 'guides/usage' },
						{ label: 'メタエージェント (ccserver-meta)', slug: 'guides/meta-agent' },
						{ label: '拠点間 (federation) ペアリング', slug: 'guides/federation' },
						{ label: 'コンボ起動', slug: 'guides/combo-launch' },
					],
				},
				{
					label: 'サンドボックス',
					items: [
						{ label: '概要と永続 HOME', slug: 'sandbox/overview' },
						{ label: '認証情報の受け渡し', slug: 'sandbox/credentials' },
						{ label: '設定ファイルと内部の仕組み', slug: 'sandbox/configuration' },
					],
				},
				{
					label: 'リファレンス',
					items: [
						{ label: 'プロジェクト構成', slug: 'reference/project-structure' },
						{ label: 'API', slug: 'reference/api' },
					],
				},
				{
					label: 'デプロイ',
					items: [
						{ label: 'systemd でバックグラウンド実行', slug: 'deployment/systemd' },
						{ label: 'Tailscale Serve で HTTPS 公開', slug: 'deployment/tailscale' },
					],
				},
			],
		}),
	],
});
