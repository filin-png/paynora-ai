import type { Dictionary } from "./en";

/** Russian strings — must have exactly the same key shape as en.ts (see dictionaries.test.ts). */
export const ru: Dictionary = {
  common: {
    openNavigation: "Открыть меню",
    closeNavigation: "Закрыть меню",
    switchOrganization: "Сменить организацию",
    signIn: "Войти",
    getStarted: "Начать",
  },
  nav: {
    overview: "Обзор",
    invoices: "Счета",
    customers: "Клиенты",
    actionCenter: "Центр действий",
    automation: "Автоматизация",
    wallet: "Кошелёк",
    settings: "Настройки",
  },
  landing: {
    badge: "Интеллектуальная аналитика дебиторской задолженности на основе ИИ",
    heroTitlePrefix: "Узнайте, куда уходят ваши",
    heroTitleHighlight: "деньги",
    heroTitleSuffix: ".",
    heroSubtitle:
      "ИИ-аналитика взыскания задолженности помогает B2B-командам видеть непогашенные суммы, отслеживать просрочки и точно знать, что делать дальше — с обязательным одобрением человеком каждого напоминания, которое рекомендует PAYNORA, или с автоматизацией на ваших условиях.",
  },
  settingsIntegrations: {
    ai: "Генерация ИИ",
    email: "Электронная почта",
    messaging: "Мессенджеры",
    billing: "Подписка PAYNORA",
    wallet: "Кошелёк / крипто-платежи",
    analytics: "Аналитика",
    webSearch: "Веб-поиск",
  },
};
