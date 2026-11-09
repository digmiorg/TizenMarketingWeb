/**
 * Brand layer for signage.digmi.eu: language, box mode, texts and small
 * decisions. Pure and dependency-free; main.js and the page load it first.
 *
 * Plain ES2017 (no optional chaining, no object spread, no `??`): the screens
 * run Chrome 63.
 */
/* global module */
(function (root) {
  'use strict';

  const LANGUAGES = ['sv', 'no', 'en', 'da', 'fi'];
  // Languages a browser language alone may pick; `en` stays explicit-only.
  const BROWSER_LANGUAGES = ['no', 'da', 'fi'];

  const MESSAGES = {
    sv: {
      eyebrow: 'digmi Signage',
      'reg.qr_label': 'QR-kod {n}',
      'reg.step': 'Steg 3 av 3',
      'reg.title.box': 'Skanna QR-kod 3',
      'reg.title_em.box': 'och aktivera skärmen.',
      'reg.title.generic': 'Aktivera skärmen',
      'reg.title_em.generic': 'med mobilen.',
      'reg.body':
        'Skanna med mobilens kamera eller digmi Marketing-appen. Logga in i digmi-portalen – har du inget konto skapar du ett där – och lägg till skärmen. Den startar av sig själv när den är aktiverad.',
      'reg.help': 'Behöver du hjälp? Ring {phone} eller gå till {url}.',
      'reg.phone_display': '010-182 10 33',
      'off.title': 'Skärmen visar inget just nu –',
      'off.title_em': 'kontakta digmi.',
      'off.body':
        'Att skanna en kod gör ingen skillnad. Ring oss eller gå till supporten nedan, så reder vi ut det.',
      'loader.starting': 'Startar…',
      'loader.sub': 'Hämtar innehåll till skärmen',
      'loading.default': 'Laddar…',
      'loading.reloading': 'Startar om…',
      'offline.banner': 'Ingen internetanslutning – innehållet fortsätter visas',
      'offline.banner_idle': 'Ingen internetanslutning',
      'toast.restored': 'Anslutningen är tillbaka – uppdaterar innehållet',
      'toast.offline': 'Ingen anslutning – försöker igen när nätet är tillbaka',
      'toast.recovery_failed': 'Kunde inte uppdatera – försöker igen när anslutningen ändras',
      'info.title': 'Enhetsinformation',
    },
    no: {
      eyebrow: 'digmi Signage',
      'reg.qr_label': 'QR-kode {n}',
      'reg.step': 'Trinn 3 av 3',
      'reg.title.box': 'Skann QR-kode 3',
      'reg.title_em.box': 'og aktiver skjermen.',
      'reg.title.generic': 'Aktiver skjermen',
      'reg.title_em.generic': 'med mobilen.',
      'reg.body':
        'Skann med mobilkameraet eller digmi Marketing-appen. Logg inn i digmi-portalen – har du ingen konto, oppretter du en der – og legg til skjermen. Den starter av seg selv når den er aktivert.',
      'reg.help': 'Trenger du hjelp? Ring {phone} eller gå til {url}.',
      'reg.phone_display': '+46 10 182 10 33',
      'off.title': 'Skjermen viser ingenting akkurat nå –',
      'off.title_em': 'kontakt digmi.',
      'off.body':
        'Å skanne en kode gjør ingen forskjell. Ring oss eller gå til supporten nedenfor, så ordner vi det.',
      'loader.starting': 'Starter…',
      'loader.sub': 'Henter innhold til skjermen',
      'loading.default': 'Laster…',
      'loading.reloading': 'Starter på nytt…',
      'offline.banner': 'Ingen internettforbindelse – innholdet vises fortsatt',
      'offline.banner_idle': 'Ingen internettforbindelse',
      'toast.restored': 'Forbindelsen er tilbake – oppdaterer innholdet',
      'toast.offline': 'Ingen forbindelse – prøver igjen når nettet er tilbake',
      'toast.recovery_failed': 'Kunne ikke oppdatere – prøver igjen når forbindelsen endres',
      'info.title': 'Enhetsinformasjon',
    },
    en: {
      eyebrow: 'digmi Signage',
      'reg.qr_label': 'QR code {n}',
      'reg.step': 'Step 3 of 3',
      'reg.title.box': 'Scan QR code 3',
      'reg.title_em.box': 'to activate the screen.',
      'reg.title.generic': 'Activate the screen',
      'reg.title_em.generic': 'with your phone.',
      // Prettier wants double quotes for this string, eslint's quotes rule single ones.
      // prettier-ignore
      'reg.body':
        'Scan with your phone\'s camera or the digmi Marketing app. Log in to the digmi portal – if you don\'t have an account, create one there – and add the screen. It starts by itself once it is activated.',
      'reg.help': 'Need help? Call {phone} or go to {url}.',
      'reg.phone_display': '+46 10 182 10 33',
      'off.title': 'The screen is not showing anything –',
      'off.title_em': 'contact digmi.',
      'off.body':
        'Scanning a code makes no difference. Call us or go to the support page below and we will sort it out.',
      'loader.starting': 'Starting…',
      'loader.sub': 'Fetching content for the screen',
      'loading.default': 'Loading…',
      'loading.reloading': 'Restarting…',
      'offline.banner': 'No internet connection – content keeps playing',
      'offline.banner_idle': 'No internet connection',
      'toast.restored': 'Connection restored – updating the content',
      'toast.offline': 'No connection – will retry when the network is back',
      'toast.recovery_failed': 'Could not update – will retry when the connection changes',
      'info.title': 'Device information',
    },
    da: {
      eyebrow: 'digmi Signage',
      'reg.qr_label': 'QR-kode {n}',
      'reg.step': 'Trin 3 af 3',
      'reg.title.box': 'Scan QR-kode 3',
      'reg.title_em.box': 'og aktivér skærmen.',
      'reg.title.generic': 'Aktivér skærmen',
      'reg.title_em.generic': 'med mobilen.',
      'reg.body':
        'Scan med mobilens kamera eller digmi Marketing-appen. Log ind i digmi-portalen – har du ikke en konto, opretter du en der – og tilføj skærmen. Den starter af sig selv, når den er aktiveret.',
      'reg.help': 'Har du brug for hjælp? Ring på {phone} eller gå til {url}.',
      'reg.phone_display': '+46 10 182 10 33',
      'off.title': 'Skærmen viser ingenting lige nu –',
      'off.title_em': 'kontakt digmi.',
      'off.body':
        'At scanne en kode gør ingen forskel. Ring til os eller gå til supporten nedenfor, så finder vi ud af det.',
      'loader.starting': 'Starter…',
      'loader.sub': 'Henter indhold til skærmen',
      'loading.default': 'Indlæser…',
      'loading.reloading': 'Genstarter…',
      'offline.banner': 'Ingen internetforbindelse – indholdet vises fortsat',
      'offline.banner_idle': 'Ingen internetforbindelse',
      'toast.restored': 'Forbindelsen er tilbage – opdaterer indholdet',
      'toast.offline': 'Ingen forbindelse – prøver igen, når nettet er tilbage',
      'toast.recovery_failed': 'Kunne ikke opdatere – prøver igen, når forbindelsen ændres',
      'info.title': 'Enhedsoplysninger',
    },
    fi: {
      eyebrow: 'digmi Signage',
      'reg.qr_label': 'QR-koodi {n}',
      'reg.step': 'Vaihe 3/3',
      'reg.title.box': 'Skannaa QR-koodi 3',
      'reg.title_em.box': 'ja aktivoi näyttö.',
      'reg.title.generic': 'Aktivoi näyttö',
      'reg.title_em.generic': 'puhelimella.',
      'reg.body':
        'Skannaa puhelimen kameralla tai digmi Marketing -sovelluksella. Kirjaudu digmi-portaaliin – jos sinulla ei ole tiliä, luo se siellä – ja lisää näyttö. Se käynnistyy itsestään, kun se on aktivoitu.',
      'reg.help': 'Tarvitsetko apua? Soita numeroon {phone} tai käy osoitteessa {url}.',
      'reg.phone_display': '+46 10 182 10 33',
      'off.title': 'Näyttö ei näytä mitään juuri nyt –',
      'off.title_em': 'ota yhteyttä digmiin.',
      'off.body':
        'Koodin skannaaminen ei muuta tilannetta. Soita meille tai käy alla olevalla tukisivulla, niin selvitämme asian.',
      'loader.starting': 'Käynnistyy…',
      'loader.sub': 'Haetaan sisältöä näytölle',
      'loading.default': 'Ladataan…',
      'loading.reloading': 'Käynnistetään uudelleen…',
      'offline.banner': 'Ei internetyhteyttä – sisältö näytetään edelleen',
      'offline.banner_idle': 'Ei internetyhteyttä',
      'toast.restored': 'Yhteys palasi – päivitetään sisältöä',
      'toast.offline': 'Ei yhteyttä – yritetään uudelleen, kun verkko palaa',
      'toast.recovery_failed': 'Päivitys epäonnistui – yritetään uudelleen, kun yhteys muuttuu',
      'info.title': 'Laitetiedot',
    },
  };

  function queryParam(search, name) {
    return new URLSearchParams(String(search || '')).get(name);
  }

  function fromTag(tag) {
    const base = String(tag || '')
      .toLowerCase()
      .split(/[-_]/)[0];
    if (base === 'nb' || base === 'nn') {
      return 'no';
    }
    return LANGUAGES.indexOf(base) === -1 ? null : base;
  }

  /** An explicit ?lang= wins, then the browser language, otherwise Swedish. */
  function resolveLanguage(search, navigatorLanguage) {
    const explicit = fromTag(queryParam(search, 'lang'));
    if (explicit) {
      return explicit;
    }
    const browser = fromTag(navigatorLanguage);
    return BROWSER_LANGUAGES.indexOf(browser) === -1 ? 'sv' : browser;
  }

  function isBox(search) {
    return queryParam(search, 'src') === 'box';
  }

  function t(lang, key, params) {
    const table = MESSAGES[lang] || MESSAGES.sv;
    const text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    if (!params) {
      return text;
    }
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /** The onboarding banner owns the offline message when its host is present. */
  function shouldShowOfflineBanner(doc) {
    return !doc.getElementById('digmi-onboard-banner-host');
  }

  function qrRenderSize(viewportWidth, viewportHeight, devicePixelRatio) {
    const share = viewportWidth >= viewportHeight ? 0.46 : 0.62;
    const size = Math.ceil(Math.min(viewportWidth, viewportHeight) * share * devicePixelRatio);
    return Math.max(size, 240);
  }

  function readParams(el) {
    const raw = el.getAttribute('data-i18n-params');
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function slotsOf(el) {
    const slots = {};
    const found = el.querySelectorAll('[data-i18n-slot]');
    for (let i = 0; i < found.length; i += 1) {
      slots[found[i].getAttribute('data-i18n-slot')] = found[i];
    }
    return slots;
  }

  /**
   * Writes `text` into `el` as text nodes. A `{name}` left in the text that
   * names a `[data-i18n-slot]` child puts that child (a link, say) back in
   * its place; nothing is ever parsed as markup.
   */
  function fillText(doc, el, text) {
    const slots = slotsOf(el);
    const parts = text.split(/\{(\w+)\}/);
    el.textContent = '';
    for (let i = 0; i < parts.length; i += 1) {
      const isName = i % 2 === 1;
      if (isName && Object.prototype.hasOwnProperty.call(slots, parts[i])) {
        el.appendChild(slots[parts[i]]);
      } else if (isName) {
        el.appendChild(doc.createTextNode('{' + parts[i] + '}'));
      } else if (parts[i]) {
        el.appendChild(doc.createTextNode(parts[i]));
      }
    }
  }

  function setHidden(doc, selector, hidden) {
    const found = doc.querySelectorAll(selector);
    for (let i = 0; i < found.length; i += 1) {
      found[i].hidden = hidden;
    }
  }

  /**
   * Fills every `[data-i18n="key"]` with t(lang, key, data-i18n-params),
   * shows `[data-box-only]` only on a box and `[data-generic-only]` only
   * elsewhere, and sets the page language.
   */
  function applyBrandTexts(doc, lang, box) {
    const found = doc.querySelectorAll('[data-i18n]');
    for (let i = 0; i < found.length; i += 1) {
      const el = found[i];
      fillText(doc, el, t(lang, el.getAttribute('data-i18n'), readParams(el)));
    }
    setHidden(doc, '[data-box-only]', !box);
    setHidden(doc, '[data-generic-only]', !!box);
    doc.documentElement.lang = lang;
  }

  const api = {
    resolveLanguage: resolveLanguage,
    isBox: isBox,
    MESSAGES: MESSAGES,
    t: t,
    shouldShowOfflineBanner: shouldShowOfflineBanner,
    qrRenderSize: qrRenderSize,
    applyBrandTexts: applyBrandTexts,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root.document !== 'undefined') {
    root.DigmiBrand = api;
  }
})(typeof window !== 'undefined' ? window : this);
