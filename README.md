# LbC Hunter

> L’assistant Chrome pour surveiller LbC, recevoir les bonnes alertes au bon moment, et agir vite sans y passer la journée.

LbC Hunter est pensé pour un usage achat-revente: il suit vos recherches, compare les prix au marché, vous alerte en temps réel et automatise une partie des actions répétitives.

## Ce que fait LbC Hunter

- Scrute vos watchlists en continu avec une orchestration fiable
- Évalue chaque annonce par rapport au marché
- Déclenche des alertes rouges/oranges selon vos seuils
- Envoie des push via ntfy (optionnel)
- Propose un mode d’achat Lite depuis les notifications
- Fournit un tableau de bord annonces + stats + P&L

## Points forts ✨

- Polling robuste: cycle toutes les 30s, intervalle par watchlist configurable de 30s à 15 min
- Moteur prix marché: médiane tronquée 5/95 pour éviter les outliers
- Backfill intelligent: chargement initial de 5 à 40 pages selon la fenêtre demandée
- Flux non bloquant: les canaux optionnels (ex: ntfy) n’interrompent pas le flux principal
- Données locales: stockage dans IndexedDB et storage Chrome

## Installation 🛠️

1. Cloner le dépôt:

```bash
git clone <url-du-repo> lbc-hunter
cd lbc-hunter
```

2. Installer et compiler:

```bash
nvm use 22
npm install
npm run build
```

3. Charger l’extension dans Chrome:

- Ouvrir chrome://extensions
- Activer le mode développeur
- Cliquer sur "Charger l’extension non empaquetée"
- Sélectionner le dossier dist

## Première configuration 🚀

1. Ouvrir https://www.leboncoin.fr et vous connecter.
2. Lancer une recherche pour initialiser la capture de session.
3. Ouvrir les Options et créer votre première watchlist.

## Paramètres watchlist

- Nom, mots-clés, catégorie
- Prix min/max
- Type de vendeur (particulier/pro/tous)
- Zone géographique (code postal, rayon)
- Intervalle de polling
- Seuil d’alerte rouge
- Filtre livraison
- Mode achat (off ou lite)
- Budget max

## Alertes et scoring 🔔

- Rouge: prix très intéressant vs marché (au-dessus de votre seuil)
- Orange: annonce pertinente mais moins agressive en prix
- Premier cycle: pas de spam d’alertes, il sert de baseline

## Backfill (historique initial)

Le backfill sert à construire des stats solides dès le début:

- Pagination adaptative (5 à 40 pages, 35 annonces/page)
- Reprise bornée sur erreurs transitoires
- Aucune alerte utilisateur pendant le seed

## Architecture (version courte)

- src/background/service-worker.js: orchestration, alarmes, messages
- src/core/poller.js: polling, déduplication, proxy fetch
- src/core/matcher.js: évaluation des deals
- src/core/notifier.js: notifications Chrome, ntfy, audio
- src/core/automator.js: auto-message et achat Lite
- src/db/indexeddb.js: accès base de données centralisé
- src/content/\*: capture session et injections UI sur le site

## Commandes utiles

```bash
npm run build
npm run test
npm run test:e2e
npm run lint:biome
npm run lint:sh
```

## Confidentialité et sécurité 🔒

- Données stockées localement (IndexedDB + storage Chrome)
- Appels externes strictement nécessaires: API du site, ntfy (optionnel), EmailJS (optionnel)
- Aucun mot de passe stocké par l’extension

## Dépannage rapide

- Session expirée: reconnectez-vous sur le site puis relancez un poll forcé
- Aucun onglet détecté: ouvrez un onglet du site et laissez un cycle passer
- Push ntfy absent: vérifiez topic, seuil et app mobile

## Nommage du projet

- Nom produit: LbC Hunter
- Nom package/repo: lbc-hunter
