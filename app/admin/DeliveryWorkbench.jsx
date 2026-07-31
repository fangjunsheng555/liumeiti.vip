"use client";

import { FileText, RefreshCw } from "lucide-react";
import { itemValidityLabel } from "../lib/order-fulfillment";

const SPOTIFY_REGIONS = [
  ["", "选择地区"],
  ["europe", "欧洲区"],
  ["us", "美国区"],
  ["japan", "日本区"],
  ["uk", "英国区"],
  ["other", "其他地区"],
];

const SPOTIFY_OUTCOMES = [
  ["family_joined", "已加入家庭组"],
  ["individual_activated", "个人订阅已开通"],
  ["duo_activated", "双人订阅已开通"],
  ["family_activated", "家庭套餐已开通"],
  ["account_provided", "已提供新账号"],
  ["activated", "订阅已开通"],
];

function CompactSwitch({ checked, onChange, label, hint }) {
  return (
    <div className="admin-delivery-switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`admin-compact-switch${checked ? " active" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
      <button type="button" className="admin-delivery-switch-copy" onClick={() => onChange(!checked)}>
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </button>
    </div>
  );
}

function SpotifyFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  return (
    <div className="admin-delivery-fields four">
      <label>
        <span>用户名</span>
        <input
          value={fulfillment.username || ""}
          onChange={(event) => onChange({ username: event.target.value })}
          placeholder="例如 User123"
          maxLength={60}
        />
      </label>
      <label>
        <span>开通地区</span>
        <select value={fulfillment.region || ""} onChange={(event) => onChange({ region: event.target.value })}>
          {SPOTIFY_REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <label>
        <span>处理结果</span>
        <select value={fulfillment.outcome || "activated"} onChange={(event) => onChange({ outcome: event.target.value })}>
          {SPOTIFY_OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <CompactSwitch
        checked={Boolean(fulfillment.emailConfirmation)}
        onChange={(value) => onChange({ emailConfirmation: value })}
        label="需要确认邮箱"
        hint="加入客户说明"
      />
    </div>
  );
}

function ProfileFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  const fullAccount = item.plan === "full";
  return (
    <div className="admin-delivery-fields three">
      <label>
        <span>{fullAccount ? "用户档案（选填）" : "车位 / 用户档案"}</span>
        <input
          value={fulfillment.profileNumber || ""}
          onChange={(event) => onChange({ profileNumber: event.target.value })}
          placeholder={fullAccount ? "整号可留空" : "例如 3"}
          maxLength={20}
        />
      </label>
      <label>
        <span>PIN（选填）</span>
        <input
          value={fulfillment.pin || ""}
          onChange={(event) => onChange({ pin: event.target.value })}
          placeholder="未设置可留空"
          maxLength={30}
        />
      </label>
      <CompactSwitch
        checked={fulfillment.loginHelp !== false}
        onChange={(value) => onChange({ loginHelp: value })}
        label="加入登录帮助"
        hint="获取帮助说明"
      />
    </div>
  );
}

function RocketFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  const linkCount = item.subscriptionLinks && typeof item.subscriptionLinks === "object"
    ? Object.values(item.subscriptionLinks).filter(Boolean).length
    : 0;
  return (
    <div className="admin-delivery-fields two">
      <div className={`admin-delivery-readonly${linkCount ? " ok" : ""}`}>
        <span>订阅链接</span>
        <b>{linkCount ? `已生成 ${linkCount} 个链接` : "尚未生成"}</b>
      </div>
      <CompactSwitch
        checked={fulfillment.clientGuide !== false}
        onChange={(value) => onChange({ clientGuide: value })}
        label="加入客户端说明"
        hint="Shadowrocket / Clash"
      />
    </div>
  );
}

function AiFields({ item, onChange }) {
  const fulfillment = item.fulfillment || {};
  return (
    <div className="admin-delivery-fields two">
      <label>
        <span>登录方式</span>
        <select value={fulfillment.loginMethod || "provided"} onChange={(event) => onChange({ loginMethod: event.target.value })}>
          <option value="provided">订单账号登录</option>
          <option value="email">邮箱登录</option>
          <option value="google">Google 登录</option>
        </select>
      </label>
      <CompactSwitch
        checked={Boolean(fulfillment.twoFactorInstruction)}
        onChange={(value) => onChange({ twoFactorInstruction: value })}
        label="加入 2FA 说明"
        hint="不在此处填写密钥"
      />
    </div>
  );
}

function ItemFields({ item, onChange }) {
  if (item.service === "spotify") return <SpotifyFields item={item} onChange={onChange} />;
  if (["netflix", "disney", "max"].includes(item.service)) return <ProfileFields item={item} onChange={onChange} />;
  if (item.service === "rocket") return <RocketFields item={item} onChange={onChange} />;
  if (item.service === "ai") return <AiFields item={item} onChange={onChange} />;
  return <p className="admin-delivery-generic">本商品沿用客户交付说明，无需额外配置。</p>;
}

export default function DeliveryWorkbench({
  order,
  items,
  customerMessage,
  internalNotes,
  internalReference,
  netflixSelfServiceEnabled,
  thirdPartyPlatformNotice,
  deliveryMessageMode,
  onFulfillmentChange,
  onGenerate,
  onCustomerMessageChange,
  onInternalNotesChange,
  onInternalReferenceChange,
  onNetflixSelfServiceChange,
  onThirdPartyChange,
}) {
  const expiryOrder = { ...order, items };
  const hasNetflix = items.some((item) => item.service === "netflix");
  return (
    <section className="admin-modal-section admin-delivery-workbench">
      <div className="admin-delivery-heading">
        <div>
          <h3>交付工作台</h3>
          <p>选择实际处理结果，生成统一的客户说明。</p>
        </div>
        <button type="button" className="admin-delivery-generate" onClick={onGenerate}>
          <RefreshCw size={12} />生成说明
        </button>
      </div>

      <div className="admin-delivery-list">
        {items.map((item, index) => (
          <div className="admin-delivery-item" key={`${item.service || "item"}-${index}`}>
            <div className="admin-delivery-item-head">
              <b>{index + 1}. {item.label}</b>
              <span>{itemValidityLabel(expiryOrder, item, order?.locale === "en" ? "en" : "zh")}</span>
            </div>
            <ItemFields item={item} onChange={(patch) => onFulfillmentChange(index, patch)} />
          </div>
        ))}
      </div>

      <div className="admin-delivery-message-head">
        <div>
          <FileText size={13} />
          <b>客户交付说明</b>
          <em>{deliveryMessageMode === "auto" ? "标准生成" : "人工编辑"}</em>
        </div>
        <CompactSwitch
          checked={Boolean(thirdPartyPlatformNotice)}
          onChange={onThirdPartyChange}
          label="第三方平台订单"
          hint="开启后自动加入确认收货提示"
        />
      </div>
      <textarea
        className="admin-notes admin-delivery-customer-note"
        value={customerMessage}
        onChange={(event) => onCustomerMessageChange(event.target.value)}
        rows={4}
        maxLength={1500}
        placeholder="点击“生成说明”，或手动填写需要发送给客户的交付结果。"
      />

      <div className="admin-delivery-internal-tools">
        <label>
          <span>内部编号 <em>选填</em></span>
          <input
            value={internalReference || ""}
            onChange={(event) => onInternalReferenceChange(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))}
            maxLength={32}
            placeholder="用于关联、搜索与批量通知"
          />
        </label>
        {hasNetflix && (
          <CompactSwitch
            checked={netflixSelfServiceEnabled !== false}
            onChange={onNetflixSelfServiceChange}
            label="允许 Netflix 自助接码"
            hint="仅限已核验的订单用户"
          />
        )}
      </div>

      <label className="admin-delivery-internal">
        <span>内部备注 <em>仅后台可见</em></span>
        <textarea
          className="admin-notes"
          value={internalNotes}
          onChange={(event) => onInternalNotesChange(event.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="采购渠道、成本、家庭组编号或其他内部处理记录。"
        />
      </label>
    </section>
  );
}
