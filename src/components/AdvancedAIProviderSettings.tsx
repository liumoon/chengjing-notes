import { useEffect, useMemo, useState } from "react";
import { Activity, Check, ChevronDown, CloudCog, Eye, EyeOff, Fingerprint, KeyRound, Plus, RefreshCw, Server, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useI18n } from "../hooks/useI18n";
import { formatCertFingerprint, getAdvancedProviderCopy, getProviderApiModeCopy, getProviderCertTrustCopy, getProviderDiagnosticCopy } from "../lib/advancedProviderCopy";
import { useAppStore } from "../store";
import type { AIProviderApiMode, AIProviderDiagnostics, AIProviderModel, AIProviderProfile, AIProviderSettings, AIProviderType } from "../types";
import { friendlyErrorMessage } from "../lib/utils";
import { getHealthCopy } from "../lib/healthCopy";

const emptySettings: AIProviderSettings = { selectedProfileId: "", profiles: [] };

export function AdvancedAIProviderSettings() {
  const { language } = useI18n();
  const copy = useMemo(() => getAdvancedProviderCopy(language), [language]);
  const modeCopy = useMemo(() => getProviderApiModeCopy(language), [language]);
  const diagnosticCopy = useMemo(() => getProviderDiagnosticCopy(language), [language]);
  const trustCopy = useMemo(() => getProviderCertTrustCopy(language), [language]);
  const healthCopy = getHealthCopy(language);
  const engine = useAppStore((state) => state.aiEngine);
  const setEngine = useAppStore((state) => state.setAIEngine);
  const setCustomProvider = useAppStore((state) => state.setCustomProvider);
  const [settings, setSettings] = useState<AIProviderSettings>(emptySettings);
  const [editingId, setEditingId] = useState("");
  const [type, setType] = useState<AIProviderType>("ollama");
  const [apiMode, setApiMode] = useState<AIProviderApiMode>("chat-completions");
  const [name, setName] = useState("Ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [certFingerprint, setCertFingerprint] = useState("");
  const [certPem, setCertPem] = useState("");
  const [trusting, setTrusting] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<AIProviderModel[]>([]);
  const [busy, setBusy] = useState<"save" | "test" | "models" | "generate" | "">("");
  const [notice, setNotice] = useState("");
  const [diagnostics, setDiagnostics] = useState<AIProviderDiagnostics | null>(null);
  const [expanded, setExpanded] = useState(false);
  const activeProfile = settings.profiles.find((profile) => profile.id === settings.selectedProfileId);
  const editingProfile = settings.profiles.find((profile) => profile.id === editingId);
  const storedFingerprint = diagnostics?.storedFingerprint || editingProfile?.certFingerprint || certFingerprint;
  const presentedFingerprint = diagnostics?.presentedFingerprint || diagnostics?.certFingerprint || "";
  const fingerprintChanged = Boolean(storedFingerprint && presentedFingerprint && diagnostics?.fingerprintMatch === false);
  const certificateExpired = diagnostics?.errorCode === "cert-expired";
  const canTrustPresentedCertificate = Boolean(
    diagnostics?.stage === "certificate"
    && !storedFingerprint
    && presentedFingerprint
    && diagnostics?.certPem,
  );
  const unsaved = Boolean(editingProfile && (editingProfile.type !== type || editingProfile.apiMode !== apiMode || editingProfile.baseUrl !== baseUrl.trim().replace(/\/$/, "") || editingProfile.model !== model.trim() || apiKey.trim() || (editingProfile.certFingerprint || "") !== certFingerprint.trim()));

  function activate(profile: AIProviderProfile) {
    setCustomProvider({ id: profile.id, name: profile.name, model: profile.model });
    setEngine("custom-provider");
  }

  function loadProfile(profile: AIProviderProfile) {
    setEditingId(profile.id); setType(profile.type); setApiMode(profile.apiMode); setName(profile.name); setBaseUrl(profile.baseUrl); setModel(profile.model); setApiKey(""); setCertFingerprint(profile.certFingerprint || ""); setCertPem(profile.certPem || ""); setModels([]); setNotice(""); setDiagnostics(null);
  }

  function resetForm(nextType: AIProviderType = "ollama") {
    setEditingId(""); setType(nextType); setApiMode("chat-completions"); setName(nextType === "ollama" ? "Ollama" : "Custom Gateway"); setBaseUrl(nextType === "ollama" ? "http://127.0.0.1:11434/v1" : "https://"); setModel(""); setApiKey(""); setCertFingerprint(""); setCertPem(""); setModels([]); setNotice(""); setDiagnostics(null);
  }

  useEffect(() => {
    const providerApi = window.chengjing?.ai;
    if (!providerApi?.providerSettings) return;
    let active = true;
    providerApi.providerSettings().then((value) => {
      if (!active) return;
      setSettings(value);
      const selected = value.profiles.find((profile) => profile.id === value.selectedProfileId) || value.profiles[0];
      if (selected) { loadProfile(selected); setCustomProvider({ id: selected.id, name: selected.name, model: selected.model }); }
    }).catch(() => {});
    return () => { active = false; };
  }, [setCustomProvider]);

  useEffect(() => { setExpanded(engine === "custom-provider"); }, [engine]);

  async function saveConnection(event: React.FormEvent) {
    event.preventDefault();
    if (!model.trim()) { setNotice(copy.chooseModel); return; }
    if (!window.chengjing) { setNotice(copy.desktop); return; }
    setBusy("save"); setNotice("");
    try {
      const value = await window.chengjing.ai.upsertProvider({ id: editingId || undefined, name, type, apiMode, baseUrl, model, ...(apiKey.trim() ? { apiKey } : {}), certFingerprint: certFingerprint.trim(), certPem: certPem.trim(), select: true });
      setSettings(value);
      const selected = value.profiles.find((profile) => profile.id === value.selectedProfileId)!;
      loadProfile(selected); activate(selected); setNotice(copy.saved);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setBusy(""); }
  }

  async function chooseProfile(profile: AIProviderProfile) {
    if (!window.chengjing) return;
    try {
      const value = await window.chengjing.ai.selectProvider(profile.id);
      setSettings(value); loadProfile(profile); activate(profile);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
  }

  async function testConnection() {
    if (!window.chengjing || !editingId || unsaved || busy) return;
    setBusy("test"); setNotice("");
    try {
      const result = await window.chengjing.ai.testProvider(editingId);
      setModels(result.models);
      setDiagnostics(result.diagnostics || null);
      if (result.ok && result.diagnostics?.stage === "ok") setNotice(copy.connected(result.models.length));
      else setNotice("");
    }
    catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setBusy(""); }
  }

  // 使用者核對指紋後才寫入信任；寫入立刻重測，讓 TLS 放行生效。
  async function trustCertificate() {
    if (storedFingerprint) return;
    const fingerprint = formatCertFingerprint(presentedFingerprint || certFingerprint);
    const certPem = String(diagnostics?.certPem || "");
    if (!window.chengjing || !editingId || !fingerprint || !certPem || trusting) return;
    setTrusting(true); setNotice("");
    try {
      const value = await window.chengjing.ai.upsertProvider({ id: editingId, name, type, apiMode, baseUrl, model, certFingerprint: fingerprint, certPem, select: settings.selectedProfileId === editingId });
      setSettings(value);
      setCertFingerprint(fingerprint); setCertPem(certPem);
      const result = await window.chengjing.ai.testProvider(editingId);
      setModels(result.models); setDiagnostics(result.diagnostics || null);
      setNotice(result.ok ? copy.connected(result.models.length) : trustCopy.trusted);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setTrusting(false); }
  }

  async function revokeTrust() {
    if (!window.chengjing || !editingProfile || trusting) return;
    setTrusting(true); setNotice("");
    try {
      const value = await window.chengjing.ai.upsertProvider({ id: editingProfile.id, name, type, apiMode, baseUrl, model, certFingerprint: "", select: settings.selectedProfileId === editingProfile.id });
      setSettings(value); setCertFingerprint(""); setCertPem(""); setNotice(trustCopy.revoke);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setTrusting(false); }
  }

  async function fetchModels() {
    if (!window.chengjing || !editingId || unsaved || busy) return;
    setBusy("models"); setNotice("");
    try { const result = await window.chengjing.ai.listProviderModels(editingId); setModels(result); setNotice(copy.connected(result.length)); }
    catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setBusy(""); }
  }

  async function removeConnection(profile: AIProviderProfile) {
    if (!window.chengjing || !window.confirm(`${copy.remove}「${profile.name}」？`)) return;
    try {
      const removedActive = profile.id === settings.selectedProfileId;
      const value = await window.chengjing.ai.removeProvider(profile.id); setSettings(value);
      const selected = value.profiles.find((item) => item.id === value.selectedProfileId);
      if (selected) { loadProfile(selected); if (engine === "custom-provider" && removedActive) activate(selected); }
      else { resetForm(); if (engine === "custom-provider") setEngine("openrouter"); }
      setNotice(copy.removed);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
  }

  async function testGeneration() {
    if (!window.chengjing || !editingProfile || unsaved || busy) return;
    setBusy("generate"); setNotice("");
    try {
      await window.chengjing.ai.providerChat({ profileId: editingProfile.id, model: editingProfile.model, messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 2048 });
      setNotice(healthCopy.generationOK);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setBusy(""); }
  }

  async function removeKey() {
    if (!window.chengjing || !editingProfile) return;
    setBusy("save");
    try {
      const value = await window.chengjing.ai.upsertProvider({ id: editingProfile.id, name, type, apiMode, baseUrl, model, apiKey: "", certFingerprint, certPem, select: settings.selectedProfileId === editingProfile.id });
      setSettings(value); setNotice(copy.saved);
    } catch (error) { setNotice(friendlyErrorMessage(error, copy.desktop)); }
    finally { setBusy(""); }
  }

  return (
    <details className="advanced-provider" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>
        <span className="advanced-provider-icon"><CloudCog size={18} /></span>
        <span><b>{copy.title}</b><small>{copy.summary}</small></span>
        <em>{copy.configured(settings.profiles.length)}</em><ChevronDown size={16} />
      </summary>
      <div className="advanced-provider-body">
        <div className="advanced-provider-intro"><span><Server size={15} /><b>{copy.advanced}</b></span><p>{copy.description}</p><small><ShieldCheck size={13} />{copy.localOnly}</small></div>
        {settings.profiles.length > 0 && <div className="provider-profile-list">{settings.profiles.map((profile) => {
          const active = profile.id === settings.selectedProfileId && engine === "custom-provider";
          return <article key={profile.id} className={active ? "is-active" : ""}>
            <button type="button" className="provider-profile-main" onClick={() => loadProfile(profile)}><span><b>{profile.name}</b><small>{profile.model}</small>{profile.certFingerprint && <em className="provider-cert-badge"><ShieldCheck size={11} />{trustCopy.badge}</em>}</span><code>{profile.type === "ollama" ? "Ollama" : "Gateway"} · {profile.apiMode === "responses" ? "Responses" : "Chat"}</code></button>
            <button type="button" className={active ? "provider-use is-active" : "provider-use"} onClick={() => void chooseProfile(profile)}>{active ? <><Check size={13} />{copy.active}</> : copy.select}</button>
            <button type="button" className="provider-remove" aria-label={copy.remove} onClick={() => void removeConnection(profile)}><Trash2 size={14} /></button>
          </article>;
        })}</div>}
        <form className="provider-form" onSubmit={saveConnection}>
          <header><b>{editingId ? editingProfile?.name || copy.title : copy.newConnection}</b>{editingId && <button type="button" onClick={() => resetForm()}><Plus size={14} />{copy.newConnection}</button>}</header>
          <div className="provider-type-choice">
            <button type="button" className={type === "ollama" ? "is-active" : ""} onClick={() => { setType("ollama"); if (!editingId) { setName("Ollama"); setBaseUrl("http://127.0.0.1:11434/v1"); } }}><Server size={15} />{copy.ollama}</button>
            <button type="button" className={type === "openai-compatible" ? "is-active" : ""} onClick={() => { setType("openai-compatible"); if (!editingId) { setName("Custom Gateway"); setBaseUrl("https://"); } }}><CloudCog size={15} />{copy.gateway}</button>
          </div>
          <div className="provider-api-mode">
            <header><b>{modeCopy.label}</b><small>{modeCopy.privacy}</small></header>
            <div>
              <button type="button" className={apiMode === "chat-completions" ? "is-active" : ""} onClick={() => setApiMode("chat-completions")}><span><b>{modeCopy.chat}</b><small>{modeCopy.chatHint}</small></span>{apiMode === "chat-completions" && <Check size={14} />}</button>
              <button type="button" className={apiMode === "responses" ? "is-active" : ""} onClick={() => setApiMode("responses")}><span><b>{modeCopy.responses}</b><small>{modeCopy.responsesHint}</small></span>{apiMode === "responses" && <Check size={14} />}</button>
            </div>
          </div>
          <div className="provider-field-grid">
            <label><span>{copy.connectionName}</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required /></label>
            <label><span>{copy.model}</span><input list="provider-model-options" value={model} onChange={(event) => setModel(event.target.value)} maxLength={240} placeholder="qwen3:8b" required /><datalist id="provider-model-options">{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</datalist></label>
          </div>
          <label className="provider-wide-field"><span>{copy.baseUrl}</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} maxLength={1000} placeholder={type === "ollama" ? "http://127.0.0.1:11434/v1" : "https://gateway.example.com/v1"} required /></label>
          <label className="provider-wide-field"><span>{copy.apiKey}</span><div><KeyRound size={14} /><input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={editingProfile?.keyConfigured ? copy.keySaved : copy.keyOptional} /><button type="button" aria-label={showKey ? "Hide" : "Show"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          {notice && <p className="provider-notice" role="status">{notice}</p>}
          {diagnostics && <p className={`provider-diagnostic is-${diagnostics.stage}`} role="status"><b>{diagnosticCopy.title}</b><span>{diagnostics.stage === "ok"
            ? diagnosticCopy.healthy(diagnostics.model || model)
            : diagnostics.stage === "url"
              ? diagnosticCopy.url
              : diagnostics.stage === "connection"
                ? diagnosticCopy.connection
                : diagnostics.stage === "api-path"
                  ? diagnosticCopy.apiPath
                  : diagnostics.stage === "http"
                    ? diagnosticCopy.http(diagnostics.status || 0)
                    : diagnostics.stage === "certificate"
                      ? fingerprintChanged
                        ? diagnosticCopy.certificateChanged
                        : certificateExpired
                          ? diagnosticCopy.certificateExpired
                          : storedFingerprint
                            ? diagnosticCopy.certificateTlsFailed
                            : diagnosticCopy.certificate
                      : diagnosticCopy.model(diagnostics.model || model)}</span>{diagnostics.stage === "certificate" && <small>{diagnosticCopy.errorCode}: {diagnostics.errorCode || diagnostics.code}</small>}</p>}
          {diagnostics?.stage === "certificate" && <div className="provider-cert-trust">
            <header><ShieldAlert size={15} /><b>{trustCopy.title}</b></header>
            <p>{fingerprintChanged ? trustCopy.changed : certificateExpired ? trustCopy.expired : storedFingerprint ? trustCopy.tlsFailed : trustCopy.warning}</p>
            {(storedFingerprint || presentedFingerprint) ? <>
              <dl>
                {storedFingerprint && <div><dt>{trustCopy.storedFingerprint}</dt><dd><code>{formatCertFingerprint(storedFingerprint)}</code></dd></div>}
                {presentedFingerprint && <div><dt>{trustCopy.presentedFingerprint}</dt><dd><code>{formatCertFingerprint(presentedFingerprint)}</code></dd></div>}
                {diagnostics.certSubject && <div><dt>{trustCopy.subject}</dt><dd>{diagnostics.certSubject}</dd></div>}
                {diagnostics.certIssuer && <div><dt>{trustCopy.issuer}</dt><dd>{diagnostics.certIssuer}</dd></div>}
                {diagnostics.certValidFrom && <div><dt>{trustCopy.validFrom}</dt><dd>{diagnostics.certValidFrom}</dd></div>}
                {diagnostics.certValidTo && <div><dt>{trustCopy.validTo}</dt><dd>{diagnostics.certValidTo}</dd></div>}
                {diagnostics.authorizationError && <div><dt>{trustCopy.authorizationError}</dt><dd>{diagnostics.authorizationError}</dd></div>}
              </dl>
              {canTrustPresentedCertificate && <button type="button" className="secondary-button" disabled={Boolean(busy) || trusting} onClick={() => void trustCertificate()}><Fingerprint size={14} className={trusting ? "spin" : ""} />{trusting ? trustCopy.trusting : trustCopy.trust}</button>}
            </> : <p className="provider-cert-unavailable">{trustCopy.unavailable}</p>}
          </div>}
          {editingId && <div className="provider-generation-check"><span>{unsaved ? healthCopy.saveFirst : healthCopy.generationHint}</span><button type="button" className="secondary-button" disabled={Boolean(busy) || unsaved} onClick={() => void testGeneration()}><Activity size={14} className={busy === "generate" ? "spin" : ""} />{busy === "generate" ? healthCopy.generating : healthCopy.generation}</button></div>}
          <footer>
            <span>{editingProfile?.keyConfigured && <button type="button" className="provider-clear-key" onClick={() => void removeKey()}>{copy.clearKey}</button>}{editingProfile?.certFingerprint && <button type="button" className="provider-clear-key" onClick={() => void revokeTrust()}>{trustCopy.revoke}</button>}</span>
            {editingId && <button type="button" className="secondary-button" disabled={Boolean(busy) || unsaved} onClick={() => void fetchModels()}><RefreshCw size={14} className={busy === "models" ? "spin" : ""} />{copy.models}</button>}
            {editingId && <button type="button" className="secondary-button" disabled={Boolean(busy) || unsaved} onClick={() => void testConnection()}><Activity size={14} className={busy === "test" ? "spin" : ""} />{busy === "test" ? copy.testing : copy.test}</button>}
            <button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === "save" ? copy.saving : copy.save}</button>
          </footer>
        </form>
      </div>
    </details>
  );
}
