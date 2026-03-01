import React from 'react';
import { SectionKey } from '../types.js';

interface GateSectionProps {
  config: any;
  editing: boolean;
  draft: any;
  setDraft: React.Dispatch<React.SetStateAction<any>>;
  sectionHeader: (title: string, section: SectionKey) => React.ReactNode;
  displayRow: (label: string, value: any, desc?: string) => React.ReactNode;
  renderNumberField: (label: string, desc: string, path: string, min?: number, max?: number) => React.ReactNode;
  renderToggleField: (label: string, desc: string, path: string) => React.ReactNode;
  t: (key: string, params?: any) => string;
}

export default function GateSection({
  config, editing, draft, setDraft, sectionHeader, displayRow, renderNumberField, renderToggleField, t,
}: GateSectionProps) {
  return (
    <div className="card">
      {sectionHeader(t('settings.gateTitle'), 'gate')}
      {editing ? (
        <div style={{ padding: '4px 0' }}>
          {renderNumberField(`💉 ${t('settings.injectionBudget')}`, t('settings.injectionBudgetDesc'), 'maxInjectionTokens', 500, 50000)}
          {renderNumberField(`🔍 ${t('settings.searchCandidates')}`, t('settings.searchCandidatesDesc'), 'searchLimit', 5, 50)}
          {renderToggleField(t('settings.skipSmallTalk'), t('settings.skipSmallTalkDesc'), 'skipSmallTalk')}

          <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
            <label style={{ fontWeight: 600, display: 'block', marginBottom: 8 }}>🔄 {t('settings.queryExpansion')}</label>
            {renderToggleField(t('settings.queryExpansion'), t('settings.queryExpansionDesc'), 'queryExpansion.enabled')}
            {draft?.queryExpansion?.enabled && (
              <div style={{ marginLeft: 16 }}>
                <label style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>{t('settings.queryExpansionVariants')}</label>
                <input
                  type="number"
                  value={draft?.queryExpansion?.maxVariants ?? 3}
                  onChange={e => setDraft((d: any) => ({ ...d, queryExpansion: { ...d.queryExpansion, maxVariants: Number(e.target.value) } }))}
                  min={2} max={5} style={{ width: 80 }}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        <table>
          <tbody>
            {displayRow(`💉 ${t('settings.injectionBudget')}`, `${config.gate?.maxInjectionTokens} tokens`, t('settings.injectionBudgetDesc'))}
            {displayRow(`🔍 ${t('settings.searchCandidates')}`, config.gate?.searchLimit ?? 30, t('settings.searchCandidatesDesc'))}
            {displayRow(t('settings.skipSmallTalk'), config.gate?.skipSmallTalk ? t('common.on') : t('common.off'), t('settings.skipSmallTalkDesc'))}
            {displayRow(`🔄 ${t('settings.queryExpansion')}`, config.gate?.queryExpansion?.enabled ? `${t('common.on')} (${config.gate.queryExpansion.maxVariants} variants)` : t('common.off'), t('settings.queryExpansionDesc'))}
          </tbody>
        </table>
      )}
    </div>
  );
}
