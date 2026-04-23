// ─────────────────────────────────────────────
//  LbC Hunter — shared constants
// ─────────────────────────────────────────────

export const CATEGORIES = {
  1: "Véhicules",
  2: "Motos",
  3: "Caravaning",
  4: "Utilitaires",
  5: "Equipement Auto",
  6: "Equipement Moto",
  7: "Equipement Caravaning",
  8: "Nautisme",
  9: "Immobilier",
  10: "Locations de vacances",
  11: "Colocations",
  12: "Bureaux & Commerces",
  13: "Terrains & Agricoles",
  14: "Informatique",
  15: "Téléphonie",
  16: "Image & Son",
  17: "Jeux & Jouets",
  18: "Mode",
  19: "Maison",
  20: "Mobilier",
  21: "Electroménager",
  22: "Arts de la Table",
  23: "Décoration",
  24: "Linge de maison",
  25: "Bricolage",
  26: "Jardinage",
  27: "Sports",
  28: "Instruments de musique",
  29: "Collection",
  30: "Livres, BD & Revues",
  31: "Vins & Gastronomie",
  32: "Animaux",
  33: "Matériel agricole",
  34: "Equipement Pro",
  35: "Autres",
  36: "Services",
  37: "Offres d'emploi",
  38: "Demandes d'emploi",
  39: "Cours particuliers",
  40: "Covoiturage",
  41: "Baby-sitting",
  42: "Troc",
};

export const SELLER_TYPES = {
  all: "Tous",
  private: "Particulier",
  pro: "Professionnel",
};

export const POLL_INTERVALS = [30, 60, 120, 300, 900]; // seconds

export const API_ENDPOINT = "https://api.lbc.fr/finder/search";

export const MAX_MESSAGES_PER_HOUR = 15;
export const MAX_MESSAGES_PER_DAY = 50;
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const SESSION_CAPTURE_CACHE_MAX_AGE_MS = 90 * 60 * 1000; // 90 min local capture cache
export const FIRST_POLL_SKIP_ALERT = true;

export const ALERT_TIERS = {
  red: "red",
  orange: "orange",
  green: "green",
};

export const UI_FEEDBACK = {
  discardSuccess: "Annonce écartée",
  discardError: "Échec de l'écartement",
};

export const DB_NAME = "lbc-hunter-db";
export const DB_VERSION = 2;

export const SESSION_REFRESH_INTERVAL_MIN = 45; // minutes between forced session refreshes

// ── Watchlist purchase modes ──────────────────
export const PURCHASE_MODES = {
  off: "off", // no auto-purchase
  lite: "lite", // confirm via notification button
  full: "full", // fully automatic (requires all safety gates)
};

export const DEFAULT_TEMPLATES = [
  {
    name: "Offre rapide particulier",
    body: `Bonjour,\n\nJe suis intéressé(e) par votre annonce « {titre} » ({prix}€). Je peux me déplacer rapidement à {ville}.\n\nCordialement`,
  },
  {
    name: "Négociation polie",
    body: `Bonjour {vendeur},\n\nVotre annonce « {titre} » m'intéresse. Seriez-vous ouvert(e) à {prix}€ pour une vente rapide et en espèces ?\n\nBonne journée`,
  },
  {
    name: "Disponibilité immédiate",
    body: `Bonjour,\n\nJe suis disponible aujourd'hui ou demain pour récupérer « {titre} » à {ville}. Est-ce que {prix}€ vous convient ?\n\nMerci d'avance`,
  },
  {
    name: "Offre livraison",
    body: `Bonjour,\n\nVotre annonce « {titre} » m'intéresse. Acceptez-vous la livraison Mondial Relay ou Colissimo ? Le prix affiché est {prix}€.\n\nCordialement`,
  },
  {
    name: "Achat revendeur pro",
    body: `Bonjour {vendeur},\n\nJe rachète du matériel d'occasion régulièrement. Je suis intéressé par « {titre} » — je peux vous faire une offre ferme à {prix}€, paiement immédiat. Disponible ce soir ou ce week-end à {ville}.`,
  },
  {
    name: "Premier contact ultra-court",
    body: `Bonjour, toujours disponible « {titre} » à {prix}€ ? Merci`,
  },
  {
    name: "Demande d'état / infos",
    body: `Bonjour {vendeur},\n\nJe suis intéressé(e) par « {titre} ». Pourriez-vous me donner plus d'informations sur l'état général et confirmer la disponibilité ?\n\nMerci d'avance`,
  },
  {
    name: "Offre + week-end",
    body: `Bonjour,\n\nVotre annonce « {titre} » m'intéresse. Je serais disponible ce week-end pour un échange en main propre à {ville}. Confirmez-vous {prix}€ ?\n\nBonne journée`,
  },
  {
    name: "Offre lot / profil",
    body: `Bonjour {vendeur},\n\nJe serais intéressé(e) par « {titre} » et d'autres articles de votre profil. Seriez-vous ouvert(e) à une offre groupée ? Prix affiché : {prix}€.\n\nCordialement`,
  },
  {
    name: "Vinted-style bref",
    body: `Bonjour ! Je prends « {titre} » si toujours dispo. Je propose {prix}€ en livraison 🙏`,
  },
];
