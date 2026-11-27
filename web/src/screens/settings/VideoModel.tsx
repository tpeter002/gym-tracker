import { useEffect, useState } from 'react';
import { changeSettings } from '../../lib/actions';
import { analyzerInfo, listModels } from '../../lib/analyzer';
import type { AnalyzerInfo, ModelOption } from '../../lib/analyzer';
import { update } from '../../lib/store';
import { MODEL_PROVIDER_TITLES, MODEL_PROVIDERS } from '../../lib/types';
import type { ModelProvider, Settings as SettingsValues } from '../../lib/types';
import { Section } from '../../ui/layout';

// What each service is and where its keys come from.
const PROVIDER_NOTES: Record<ModelProvider, string> = {
  anthropic: 'Claude models. Keys come from platform.claude.com.',
  zai: 'GLM models; glm-4.6v-flash is free. Keys come from z.ai, under API Keys.',
  openrouter: 'Hundreds of models behind one key from openrouter.ai; the free ones have a daily limit.',
  gemini: 'Gemini models; the Flash ones have a free daily allowance. Keys come from aistudio.google.com.',
};

/** Choose which model names the exercises in a video, and whose key pays for it. */
export function VideoModel({ settings, checked }: { settings: SettingsValues; checked: number }) {
  const provider = settings.modelProvider;
  const [info, setInfo] = useState<AnalyzerInfo | null>(null);
  const [options, setOptions] = useState<ModelOption[]>([]);

  // Asked when the service changes and after a connection test, not on every
  // letter typed into the address above.
  useEffect(() => {
    let current = true;
    setOptions([]);
    if (!provider) return;
    void analyzerInfo(settings.analyzerURL).then((found) => current && setInfo(found));
    void listModels(settings.analyzerURL, provider).then((found) => current && setOptions(found));
    return () => {
      current = false;
    };
  }, [provider, checked]);

  const known = provider ? info?.providers.find((candidate) => candidate.id === provider) : undefined;
  const title = provider ? MODEL_PROVIDER_TITLES[provider] : '';

  let footer: React.ReactNode = 'The analyzer decides: Claude, unless its server/.env names another model. Pick a service to choose the model yourself or to use a key of your own.';
  if (provider) {
    let warning: string | null = null;
    if (info && info.providers.length === 0) {
      warning = 'This analyzer is an older version and ignores the choice — update it and start it again.';
    } else if (known && !known.hasKey && !settings.apiKeys[provider].trim()) {
      warning = `The analyzer has no key for ${title}, so it needs yours.`;
    }
    footer = (
      <>
        {PROVIDER_NOTES[provider]} Your key stays in this browser (backups leave it out) and is sent to your analyzer
        with each video; leave it empty to use the analyzer's own.
        {warning && <span className="error-text" role="status"> {warning}</span>}
      </>
    );
  }

  return (
    <Section title="Video model" footer={footer}>
      <label className="row">
        Service
        <select
          className="field"
          value={provider}
          onChange={(event) => changeSettings({ modelProvider: event.target.value as ModelProvider | '' })}
        >
          <option value="">Analyzer's choice</option>
          {MODEL_PROVIDERS.map((id) => <option key={id} value={id}>{MODEL_PROVIDER_TITLES[id]}</option>)}
        </select>
      </label>
      {provider && (
        <>
          <label className="row">
            Model
            <input
              className="field right"
              list="model-suggestions"
              placeholder={known?.defaultModel ? `Default: ${known.defaultModel}` : 'Default model'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={settings.models[provider]}
              onChange={(event) => update((draft) => {
                draft.settings.models[provider] = event.target.value;
              })}
            />
            <datalist id="model-suggestions">
              {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </datalist>
          </label>
          <label className="row">
            API key
            <input
              className="field right"
              type="password"
              placeholder={known?.hasKey ? "Using the analyzer's key" : `Your own ${title} key`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={settings.apiKeys[provider]}
              onChange={(event) => update((draft) => {
                draft.settings.apiKeys[provider] = event.target.value;
              })}
            />
          </label>
        </>
      )}
    </Section>
  );
}
