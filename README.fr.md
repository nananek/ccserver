# ccserver

**Langues :** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server** : serveur web de gestion du contexte des sessions CLI d'IA et de coordination entre agents.

> **Note :** il s'agit d'un outil tiers non officiel. Il n'est ni affilié aux éditeurs ou projets des CLI d'IA prises en charge, ni officiellement supporté ou approuvé par eux.

ccserver est une interface web permettant de lancer et de gérer plusieurs CLI d'IA dans un répertoire choisi : [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [opencode](https://opencode.ai/), [GitHub Copilot CLI](https://github.com/github/copilot-cli) et [OpenAI Codex CLI](https://developers.openai.com/codex/cli/). Choisissez un dossier comme dans VS Code et travaillez dans un terminal accessible depuis le navigateur.

## Architecture

```
Navigateur (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> CLI d'IA
                      <── HTTP REST ──>       (API des répertoires)
```

| Couche | Technologies |
|---|---|
| Frontend | React 19 + Vite + xterm.js |
| Backend | Node.js + Fastify + @fastify/websocket + node-pty |

## Prérequis

- Node.js >= 22.13 et npm >= 9 (utilise `node:sqlite` intégré ; le serveur ouvre SQLite (`~/.local/share/ccserver/ccserver.sqlite3`) au démarrage et refuse de démarrer avec un journal clair en cas d'échec de migration)
- Un compilateur C++ pour construire `node-pty` (`base-devel` sur Arch, `build-essential` sur Ubuntu)
- Au moins une CLI d'IA prise en charge installée sur le serveur. Seules les CLI installées sont sélectionnables.
- Facultatif : `bwrap` (bubblewrap), Docker rootless, `rootlesskit`, `uidmap` et `slirp4netns` pour toutes les fonctions du bac à sable

Installez les CLI séparément en suivant leur documentation officielle. Claude Code est également utilisé par la fonction Usage ; opencode, Copilot CLI et Codex restent utilisables sans Claude Code.

## Installation et démarrage

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
npm run setup           # simulation : affiche où iront config et état
npm run setup -- --yes  # création
```

`npm run setup` doit être exécuté une fois par hôte, y compris pour une installation neuve. Il crée
`~/.config/ccserver`, `~/.local/share/ccserver` et `~/.local/state/ccserver` (XDG) et, sur une
installation existante, déplace la configuration et l'état hors de l'arborescence du dépôt. Tant
qu'il n'a pas été exécuté, l'interface web refuse de créer de nouvelles sessions ou de nouveaux
groupes. Exécutez-le serveur arrêté. Voir [Configuration](#configuration).

### Développement

Exécutez ces commandes dans deux terminaux :

```bash
# Backend (port 3001)
npm run dev:server

# Frontend (port 5173)
npm run dev:client
```

Ouvrez <http://localhost:5173>.

### Production

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

> **Note :** Si votre shell définit `NODE_ENV=production`, `npm install` / `npm ci` ignorent les devDependencies (vite, etc.) et `npm run build --workspace=client` échoue avec `vite: not found`. Dans ce cas, installez avec `npm install --include=dev`. Les sessions lancées par ccserver n'héritent pas de `NODE_ENV` / `PORT` / `CCSERVER_*` (variables réservées au serveur, elles sont retirées).

Ouvrez <http://localhost:3001>. Le port peut être modifié avec `PORT`.

## Utilisation

1. Choisissez un dossier dans le navigateur de répertoires. Un clic ouvre un dossier ; un double-clic lance l'application par défaut dans ce dossier.
2. Utilisez le terminal intégré au navigateur.
3. Le menu de lancement permet de choisir Claude Code, opencode, GitHub Copilot ou OpenAI Codex, et d'activer si nécessaire le bac à sable, la signature GPG ou le transfert de l'agent SSH.

L'application et les options de lancement sont mémorisées dans le `localStorage` du navigateur. Les sessions combo peuvent utiliser deux workers et un orchestrateur. Elles prennent en charge Claude Code, opencode et OpenAI Codex. Copilot CLI ne peut pas être utilisé en combo car il ne peut pas recevoir les outils MCP de ccserver via les arguments CLI ou les variables d'environnement (configuration par fichier uniquement). Codex est injecté par processus via `-c mcp_servers...` sans modifier `~/.codex/config.toml`.

**Préréglages de workers** : des modèles de lancement combinant nom affiché, rôle technique (`workerImplement`, ... -- l'identifiant utilisé pour les handoffs MCP, les git worktrees et les ids de session), CLI et modèle peuvent être stockés côté serveur dans SQLite (`~/.local/share/ccserver/ccserver.sqlite3`, remplaçable par `CCSERVER_DB_PATH`) et sélectionnés ensemble dans la section « Worker プリセット » du modal combo. Créez-les, modifiez-les ou supprimez-les via le dialogue プリセット管理 : ces changements n'affectent que les sélections futures, car les sélections sont développées en instantané au lancement. Si l'API des préréglages est indisponible, les brouillons classiques workerA/workerB continuent de fonctionner. Les onglets de groupe affichent les membres nommés sous la forme `実装担当（workerImplement）`, avec repli sur le libellé du rôle.

Le bouton représentant une horloge permet de programmer des prompts. Ceux-ci sont conservés dans `~/.local/state/ccserver/scheduled-prompts.json` (remplaçable par `CCSERVER_SCHEDULES_PATH`) et peuvent être exécutés après la fermeture du navigateur ou un redémarrage du serveur. L'heure est interprétée dans le fuseau horaire du serveur.

**Partage de session** (opt-in, `CCSERVER_SESSION_SHARING=1`) : une session peut être ouverte simultanément sur plusieurs appareils -- l'ouvrir depuis un téléphone ne déconnecte pas le poste de travail, et les entrées comme les sorties sont partagées par tous (comme une session tmux partagée). Un pty n'a qu'une seule taille : une fois le partage activé, il adopte donc la plus petite fenêtre parmi les clients connectés ; les écrans plus larges affichent une marge inutilisée et chaque client reste lisible. Désactivé par défaut : un second client qui se connecte reprend simplement la session à la place du premier, comme ccserver le faisait avant l'existence de cette fonctionnalité -- un client en arrière-plan (onglet caché) n'a aucun moyen fiable de signaler qu'il n'est pas réellement affiché, et laissé dans la négociation de taille, il peut sinon figer l'écran de tous les vrais clients à une taille minuscule indéfiniment. Une session sans aucun client connecté est détruite après `CCSERVER_SESSION_TIMEOUT_MS` (2 heures par défaut ; `0` désactive complètement la destruction), et une session dont le pty s'est terminé est conservée pendant `CCSERVER_SESSION_EXITED_TIMEOUT_MS` (5 minutes par défaut) afin que son code de sortie reste consultable. Chaque destruction de session est journalisée avec son motif -- `journalctl -u ccserver | grep '[session]'` répond à la question « pourquoi ma session s'est-elle terminée ? ». Voir le [guide du partage de session](https://nananek.github.io/ccserver/guides/session-sharing/).

## Outils MCP

- `ccserver-notify` fournit `notify`, `subscribe`, `unsubscribe` et `list_subscriptions`. Les notifications peuvent être envoyées vers Discord et vers des webhooks abonnés. Configurez-les avec `notify.discordWebhook`, `notify.subscriptions`, `CCSERVER_DISCORD_WEBHOOK` ou `CCSERVER_HOSTNAME`.
- `ccserver-usage` fournit `get_usage` pour consulter l'utilisation de Claude Code. Il n'est injecté que dans les sessions Claude et uniquement si `usageMcp: true` est activé explicitement.
- Les orchestrateurs combo peuvent utiliser `send_input`, `wait_for_handoff` et `read_output` pour coordonner les workers. Gardez les instructions `send_input` courtes et sur une seule ligne, puis vérifiez la sortie du worker.

## Bac à sable

L'option **Lancer dans le bac à sable** démarre la CLI sous `bwrap`. Seuls le projet sélectionné et les répertoires de configuration autorisés sont visibles ; les projets voisins restent inaccessibles. Lorsque cela est possible, Docker rootless s'exécute également à l'intérieur du bac à sable.

Le répertoire HOME du bac à sable est persistant par projet par défaut, sous `~/.local/share/ccserver-sandbox/home/`. Cette arborescence reste volontairement en place après la migration XDG (les HOME persistants et les git worktrees contiennent des chemins absolus ; voir [Configuration](#configuration)). Définissez `persistentHome: false` pour obtenir un HOME temporaire à chaque session. Ces répertoires persistants sont inscriptibles et peuvent contenir des outils, caches et configurations shell du projet.

Pour Docker sur Debian/Ubuntu :

```bash
sudo apt install uidmap slirp4netns
```

Le transfert GPG, le transfert de l'agent SSH et le broker git/`gh` sont des options indépendantes. Le transfert SSH donne à tous les processus du bac à sable accès à l'agent ; laissez-le désactivé sauf nécessité.

## Configuration

ccserver sépare ses réglages en deux, et l'appartenance se décide par une seule question :
**la sécurité d'une session déjà en cours dépend-elle de cette valeur ?** Si oui, le réglage est
statique.

- **Dynamique** -- modifiable depuis l'interface web, effet immédiat : stocké dans la table
  SQLite `settings`.
- **Statique** -- lu une seule fois au démarrage, nécessite un redémarrage, en particulier les
  frontières de sécurité (`browseRoots`, `forceSandbox`, `allowUnsandboxedAgents`,
  `hiddenApps`) : stocké dans `~/.config/ccserver/sandbox.config.json`.

`npm run setup` crée ce fichier pour vous :

```bash
npm run setup -- --yes
$EDITOR ~/.config/ccserver/sandbox.config.json
# Chemin alternatif facultatif :
# CCSERVER_SANDBOX_CONFIG=/chemin/vers/config.json
```

Le fichier généré est volontairement minimal. Copier `server/sandbox.config.example.json` tel quel
activerait `"gpg": true`, transférant silencieusement le gpg-agent de l'hôte et `~/.gnupg` dans
chaque bac à sable ; utilisez `npm run setup -- --yes --seed-example` si vous voulez malgré tout
l'exemple complet. `server/sandbox.config.example.json` documente chaque clé et sa valeur par
défaut.

Exemple :

```json
{
  "docker": true,
  "persistentHome": true,
  "gpg": false,
  "sshAgent": false,
  "gitBroker": true,
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "notify": { "discordWebhook": "", "subscriptions": [] },
  "binds": [],
  "env": {}
}
```

Les principales options sont `docker`, `persistentHome`, `gpg`, `sshAgent`, `gitBroker`, `forceSandbox`, `defaultApp`, `showUsage`, `usageMcp`, `binds` et `env`. Consultez le README japonais pour la référence complète et les limites de sécurité.

Tous les chemins utilisés par ccserver peuvent être remplacés par une variable d'environnement
(`CCSERVER_DB_PATH`, `CCSERVER_GROUPS_PATH`, `CCSERVER_SCHEDULES_PATH`, ...) ; un chemin ainsi
défini n'est jamais touché par `npm run setup`. La liste complète, et le raisonnement derrière la
séparation dynamique/statique, se trouvent sur le site de documentation, section
Référence -> 設定モデル.

## API

Définissez `CCSERVER_TOKEN` pour protéger toutes les requêtes `/api` et `/ws`. Le client peut envoyer `?token=<TOKEN>` ou `Authorization: Bearer <TOKEN>`.

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

Pour une connexion par passkey (WebAuthn) par appareil, avec récupération par jeton à usage unique émis via SSH plutôt qu'un unique jeton partagé, définissez `CCSERVER_AUTH_MODE=passkey` (`none`/`token` restent inchangés et demeurent la valeur par défaut si non définie). Voir le [guide d'authentification](https://nananek.github.io/ccserver/guides/auth/) (en japonais) pour les contraintes d'environnement de WebAuthn.

Les endpoints REST principaux sont :

| Méthode | Chemin | Fonction |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | Lister le contenu d'un répertoire |
| GET | `/api/dirs/home` | Obtenir le HOME et les CLI disponibles |
| POST | `/api/dirs` | Créer un dossier |
| GET / DELETE | `/api/sessions[/:id]` | Lister ou arrêter des sessions |
| GET / POST | `/api/files` | Télécharger ou envoyer des fichiers |
| GET | `/api/files/content?path=<path>` | Aperçu en ligne d'un fichier `.md` / `.txt` en JSON (`{ path, name, size, mtime, kind, content, truncated }` ; premier Mio ; autres extensions et binaires refusés avec 415) |
| GET | `/api/system-stats` | Statistiques CPU, mémoire, température, GPU et stockage |
| GET | `/api/usage?force=1` | Instantané d'utilisation de Claude Code |
| GET / POST | `/api/worker-presets` | Lister / créer des préréglages de workers (`{ name, role, app, model }`, `model` peut être null) |
| PUT / DELETE | `/api/worker-presets/:id` | Mise à jour complète / suppression d'un préréglage ; rôle dupliqué -> 409 |
| POST | `/api/groups` | Lancement combo. En plus des clés historiques `workerA`/`workerB`/`orchestrator`, accepte le format canonique `workers: [{ name?, role, app?, model?, sandboxOpts? }]` (1–7 entrées, rôles uniques). Le client développe les préréglages en instantanés ; copilot est refusé avec 400 sur les deux chemins |

Les entrées/sorties du terminal et la gestion des sessions passent par `/ws/terminal` en WebSocket.

## Exécution avec systemd

Compilez le client, exécutez l'assistant de configuration, puis installez l'unité fournie :

```bash
npm run build --workspace=client
npm run setup -- --yes
mkdir -p ~/.config/systemd/user
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
systemctl --user daemon-reload
systemctl --user enable --now ccserver
systemctl --user status ccserver
```

### Mise à jour

```bash
systemctl --user stop ccserver     # migrer serveur arrêté
git pull
npm ci
npm run build --workspace=client
npm run setup                      # vérifier le plan d'abord
npm run setup -- --yes
systemctl --user start ccserver
```

Après la migration, démarrez toujours ccserver depuis une copie de travail qui inclut cette
disposition. Les branches plus anciennes résolvent les anciens chemins et démarreraient avec un
état vide.

## HTTPS avec Tailscale Serve

Une fois ccserver démarré, exposez le port 3001 à votre Tailnet :

```bash
sudo tailscale serve --bg 3001
tailscale serve status
```

## Licence

MIT
