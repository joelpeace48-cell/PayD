import { useTranslation } from 'react-i18next';

export default function Settings() {
  const { t, i18n } = useTranslation();

  const handleChangeLanguage = (event: React.ChangeEvent<HTMLSelectElement>) => {
    void i18n.changeLanguage(event.target.value);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-start p-6 md:p-12 max-w-3xl mx-auto w-full">
      <div className="w-full mb-8 md:mb-12 flex items-end justify-between border-b border-hi pb-6 md:pb-8">
        <div>
          <h1 className="text-3xl md:text-4xl font-black mb-2 tracking-tight">
            {t('settings.title')}
          </h1>
        </div>
      </div>

      <div className="w-full card glass noise p-6 md:p-8">
        <div className="flex flex-col gap-3">
          <label
            htmlFor="language-select"
            className="block text-xs font-bold uppercase tracking-widest text-muted"
          >
            {t('settings.languageLabel')}
          </label>
          <p className="text-sm text-muted">{t('settings.languageDescription')}</p>
          <select
            id="language-select"
            value={i18n.language}
            onChange={handleChangeLanguage}
            aria-label={t('settings.languageLabel')}
            className="w-full bg-black/20 border border-hi rounded-xl p-4 text-text outline-none focus:border-accent/50 focus:bg-accent/5 transition-all"
          >
            <option value="en" className="bg-surface text-text">
              {t('settings.languageEnglish')}
            </option>
            <option value="es" className="bg-surface text-text">
              {t('settings.languageSpanish')}
            </option>
          </select>
        </div>
      </div>
    </div>
  );
}
