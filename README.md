# LbC Hunter 🎯

![Node](https://img.shields.io/badge/node-22.x-brightgreen)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-4285F4?logo=googlechrome&logoColor=white)
![Version](https://img.shields.io/badge/version-1.0.0-orange)

> **Surveille Leboncoin pour vous. Identifie les vraies bonnes affaires. Agit avant tout le monde.**

Extension Chrome pour les acheteurs-revendeurs sérieux : polling en temps réel, scoring des prix par rapport au marché, alertes instantanées, et automatisation des actions répétitives — le tout sans quitter votre navigateur.

---

## Table des matières

- [Pourquoi LbC Hunter ?](#pourquoi-lbc-hunter-)
- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
- [Installation](#installation-)
- [Première utilisation](#première-utilisation-)
- [Paramètres d'une watchlist](#paramètres-dune-watchlist)
- [Alertes et scoring](#alertes-et-scoring-)
- [Notifications push](#notifications-push-)
- [Auto-message et achat Lite](#auto-message-et-achat-lite-)
- [Tableau de bord et rapports](#tableau-de-bord-et-rapports-)
- [Architecture](#architecture-)
- [Commandes développeur](#commandes-développeur)
- [Dépannage](#dépannage-)
- [Contribuer](#contribuer)

---

## Pourquoi LbC Hunter ?

Sans outil, dénicher une bonne affaire sur Leboncoin, c'est : ouvrir quinze onglets, recharger toutes les dix minutes, essayer de deviner si le prix est vraiment intéressant, et finalement rater la fenêtre de quelques minutes qui fait la différence.

**LbC Hunter fait ça pour vous, en continu.** Il surveille vos recherches, calcule un score d'attractivité objectif basé sur les prix du marché réel, vous alerte immédiatement quand une affaire se présente, et peut même envoyer le premier message automatiquement.

---

## Fonctionnalités

### 🔄 Polling continu et fiable
- Cycle automatique configurable de **30 secondes à 15 minutes** par watchlist
- Service worker MV3 : tourne en arrière-plan même quand le popup est fermé
- Première passe silencieuse : pas d'alerte au démarrage, juste une baseline

### 📊 Scoring marché intelligent
- Médiane des prix calculée sur les annonces actives (percentile 5/95 — sans outliers ni listings aberrants)
- Minimum **5 annonces** pour avoir une baseline fiable avant de déclencher des alertes
- Calcul précis du **% d'écart par rapport au marché** pour chaque annonce

### 🔔 Alertes en deux niveaux

| Niveau | Quand ? |
|--------|---------|
| 🔴 **Rouge** | Le prix est X% sous la médiane du marché (seuil configurable, 15% par défaut) |
| 🟠 **Orange** | L'annonce correspond à vos critères mais reste dans les prix habituels du marché |

### 🔙 Backfill initial automatique
Quand vous créez une watchlist, LbC Hunter charge automatiquement l'historique récent (5 à 40 pages × 35 annonces) pour construire des stats solides dès le départ — sans déclencher la moindre alerte.

### 🤖 Auto-message et achat Lite
- Envoi automatique d'un message personnalisé dès qu'une alerte rouge se déclenche
- Plafonds configurables : **15 messages/heure** et **50 messages/jour** (modifiables dans les Options)
- Mode achat Lite : initier un achat directement depuis la notification Chrome

### 📲 Notifications push sur mobile
- Intégration optionnelle avec [ntfy.sh](https://ntfy.sh) ou votre propre serveur ntfy auto-hébergé
- Recevez les alertes sur votre téléphone en temps réel
- Seuil configurable (rouge uniquement, ou rouge + orange)

### 📋 Tableau de bord complet
- Vue de toutes les annonces détectées, watchlist par watchlist
- Stats de marché (médiane, taille de l'échantillon)
- Suivi P&L (profits et pertes) sur vos achats

### 📧 Rapports par email
- Génération de rapports d'activité envoyables via `mailto:` ou [EmailJS](https://www.emailjs.com)

### 🛡️ Confidentialité totale
- Toutes vos données restent **sur votre machine** (IndexedDB + storage Chrome)
- Aucune donnée transmise à un serveur tiers, sauf ntfy et EmailJS si vous les activez explicitement
- La session Leboncoin est capturée localement et n'est jamais transmise à l'extérieur

---

## Prérequis

- **Node.js 22.x** — via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`)
- **Google Chrome** (ou Chromium)
- Un compte **Leboncoin** actif

---

## Installation 🛠️

### 1. Cloner et compiler

```bash
git clone git@github.com:y-abs/lbc-hunter.git
cd lbc-hunter
nvm use 22
npm install
npm run build
```

Le dossier `dist/` contient l'extension compilée et prête à charger.

### 2. Charger dans Chrome

1. Ouvrez `chrome://extensions`
2. Activez le **mode développeur** (bouton en haut à droite)
3. Cliquez sur **"Charger l'extension non empaquetée"**
4. Sélectionnez le dossier `dist/`

L'icône LbC Hunter apparaît dans la barre d'outils — vous êtes prêt !

---

## Première utilisation 🚀

1. **Connectez-vous** sur [leboncoin.fr](https://www.leboncoin.fr) — la session est capturée automatiquement en arrière-plan.
2. **Lancez une recherche** sur le site pour déclencher la capture de la clé API.
3. **Ouvrez les Options** depuis le popup (ou clic droit sur l'icône → Options).
4. **Créez votre première watchlist** avec vos mots-clés, catégorie et critères de prix.
5. LbC Hunter commence à surveiller immédiatement. 🎉

> **Astuce :** Laissez un onglet Leboncoin ouvert en arrière-plan. Le service worker l'utilise comme proxy pour ses appels API — sans lui, le polling ne peut pas démarrer.

---

## Paramètres d'une watchlist

| Paramètre | Description | Valeur par défaut |
|-----------|-------------|:-----------------:|
| Nom | Identifiant libre de la watchlist | — |
| Mots-clés | Termes de recherche | — |
| Catégorie | Parmi 40+ catégories (Véhicules, Immo, Informatique…) | Toutes |
| Prix min / max | Filtre de prix strict (annonces hors fourchette ignorées) | — |
| Type de vendeur | Particulier / Professionnel / Tous | Tous |
| Code postal + rayon | Zone géographique (filtre par distance en km) | — |
| Intervalle de polling | 30s / 1 min / 2 min / 5 min / 15 min | 5 min |
| Seuil alerte rouge | % sous la médiane du marché pour déclencher le rouge | 15 % |
| Livraison | Inclure / Exclure les annonces avec envoi | Tous |
| Mode achat | Désactivé ou Lite (achat depuis notification) | Désactivé |
| Budget max | Montant maximum pour le mode achat Lite | — |
| Données marché requises | Ne pas alerter tant que la baseline n'est pas établie | Oui |

---

## Alertes et scoring 🔔

LbC Hunter calcule pour chaque annonce son **écart par rapport à la médiane du marché** :

```
écart = ((médiane_marché - prix_annonce) / médiane_marché) × 100
```

- Si `écart ≥ seuil` (défaut 15 %) → alerte 🔴 **rouge** avec son fort
- Sinon → alerte 🟠 **orange** avec son discret

**Conditions pour que la médiane soit fiable :**
- Au moins **5 annonces** avec un prix valide dans la watchlist
- Calcul sur le percentile 5/95 (les prix aberrants sont ignorés)

**Premier cycle toujours silencieux :** quand vous créez une watchlist, le premier scan stocke les annonces sans déclencher d'alerte. C'est la baseline — les alertes commencent au cycle suivant.

---

## Notifications push 📲

### ntfy (recommandé pour le mobile)

1. Créez un compte sur [ntfy.sh](https://ntfy.sh) (ou installez votre propre serveur).
2. Dans les Options de LbC Hunter, renseignez votre **topic ntfy** et éventuellement l'URL de votre serveur.
3. Choisissez le seuil minimum (rouge uniquement ou rouge + orange).
4. Installez l'app ntfy sur votre téléphone et abonnez-vous au même topic.

Les alertes arrivent sur votre mobile en quelques secondes.

### EmailJS (pour les rapports)

LbC Hunter peut envoyer des rapports d'activité par email via [EmailJS](https://www.emailjs.com). Renseignez votre **Service ID**, **Template ID** et **Public Key** dans les Options.

---

## Auto-message et achat Lite 🤖

Quand une alerte rouge se déclenche, LbC Hunter peut envoyer automatiquement un message au vendeur en utilisant un template que vous définissez dans les Options.

**Limites anti-spam :**
- Maximum **15 messages par heure**
- Maximum **50 messages par jour**
- Ces plafonds sont configurables dans les Options

**Mode achat Lite :** permet d'initier un achat directement depuis la notification Chrome, sans ouvrir manuellement la page de l'annonce.

---

## Tableau de bord et rapports 📊

Le tableau de bord (accessible depuis le popup) affiche :
- Toutes les annonces détectées, triées par watchlist
- Les stats de marché de chaque watchlist (médiane, nombre d'annonces échantillonnées)
- Le suivi de vos achats avec P&L (prix d'achat vs prix de revente estimé)

---

## Architecture 🏗️

```
src/
├── background/
│   └── service-worker.js      ← orchestration principale, alarmes Chrome, messages inter-composants
├── core/
│   ├── poller.js              ← cycle de polling, déduplication, proxy fetch via content-script
│   ├── matcher.js             ← scoring des annonces vs médiane du marché
│   ├── notifier.js            ← notifications Chrome, ntfy, son (offscreen)
│   ├── automator.js           ← auto-message, achat Lite, rate limiting
│   └── reporter.js            ← génération de rapports, envoi mailto / EmailJS
├── db/
│   └── indexeddb.js           ← accès centralisé à IndexedDB (jamais contourné)
├── content/
│   ├── page-interceptor.js    ← capture de la clé API en MAIN world (avant le site)
│   ├── session-capture.js     ← relais session → service worker
│   ├── inject-badges.js       ← badges prix sur les résultats de recherche Leboncoin
│   ├── inject-adpage.js       ← panneau d'infos sur la page d'une annonce
│   └── inject-sidebar.js      ← sidebar des watchlists actives
├── dashboard/                 ← page tableau de bord
├── options/                   ← page de configuration
├── popup/                     ← popup de l'extension
├── offscreen/                 ← document offscreen pour la lecture audio (MV3)
└── shared/
    ├── constants.js           ← intervalles, seuils, limites, noms de stores
    ├── messages.js            ← schémas des messages inter-composants
    └── utils.js               ← utilitaires partagés (DOM sécurisé, URL, géo…)
```

---

## Commandes développeur

```bash
# Compilation
npm run build          # build de production (dans dist/)
npm run dev            # mode watch — rebuild à chaque sauvegarde

# Tests
npm run test           # tests unitaires + intégration (Vitest)
npm run test:watch     # tests en mode watch
npm run test:e2e       # tests end-to-end complets (Playwright)
npm run test:cov       # tests avec rapport de couverture

# Qualité
npm run lint:biome     # lint et formatage JS/TS (Biome)
npm run lint:sh        # lint des scripts shell (shellcheck)
```

> Tous les tests nécessitent **Node 22** (`nvm use 22`).

---

## Dépannage 🔧

| Symptôme | Cause probable | Solution |
|----------|---------------|---------|
| "Session expirée" | Inactivité sur Leboncoin (TTL 6h) | Reconnectez-vous sur leboncoin.fr, puis forcez un poll depuis le popup |
| Aucun onglet détecté | Pas d'onglet Leboncoin ouvert | Ouvrez un onglet leboncoin.fr et attendez le prochain cycle |
| Pas d'alerte malgré des annonces | Baseline pas encore établie | Attendez quelques cycles — il faut ≥ 5 annonces pour calculer la médiane |
| Alerte rouge jamais déclenchée | Seuil trop élevé ou marché sans outlier | Vérifiez le seuil dans les paramètres de la watchlist (défaut 15 %) |
| Pas de notification push ntfy | Mauvaise config ou app mobile inactive | Vérifiez le topic, le seuil minimum et que l'app ntfy est abonnée |
| Auto-message bloqué | Plafond horaire ou journalier atteint | Attendez la prochaine heure/journée, ou ajustez les limites dans les Options |
| L'extension ne se charge pas | Build manquant ou incomplet | Relancez `npm run build` et rechargez l'extension dans `chrome://extensions` |

---

## Contribuer

Les issues et PR sont les bienvenus ! Pour contribuer :

1. Forkez le dépôt et créez une branche (`git checkout -b feat/ma-fonctionnalite`)
2. Implémentez vos changements — toujours accompagnés de tests
3. Vérifiez que tout est vert : `npm run test && npm run lint:biome`
4. Ouvrez une PR avec une description claire de ce que vous apportez

---

<sub>Fait avec ❤️ pour les chasseurs de bonnes affaires · Node 22 · Chrome MV3</sub>
