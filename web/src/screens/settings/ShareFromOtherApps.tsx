import { CircleCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import { shareAddress } from '../../lib/inbox';
import type { Settings as SettingsValues } from '../../lib/types';
import { Section } from '../../ui/layout';

/**
 * The address an iOS Shortcut posts shared videos to, and how to make that
 * Shortcut. A web page can't be in the share sheet itself; this is the way round.
 */
export function ShareFromOtherApps({ settings }: { settings: SettingsValues }) {
  const address = shareAddress(settings, document.baseURI);
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Browsers offer the clipboard on https only; from the Mac's http address the older way still works.
      field.current?.focus();
      field.current?.setSelectionRange(0, address.length);
      setCopied(document.execCommand('copy'));
    }
  };

  return (
    <Section
      title="Share from other apps"
      footer="The address belongs to this copy of the app — one on the Home Screen and one in a browser tab each have their own. It works while the analyzer is running and within the phone's reach."
    >
      <div className="row">
        <input
          ref={field}
          className="field"
          readOnly
          aria-label="Share address"
          value={address}
          onFocus={(event) => event.target.select()}
        />
      </div>
      <button className="row accent" onClick={() => void copy()}>
        <span className="grow">Copy Address</span>
        {copied === true && <span className="ok-text"><CircleCheck size={18} aria-hidden />Copied</span>}
        {copied === false && <span className="secondary small">Select it above and copy</span>}
      </button>
      <div className="row">
        <ol className="steps">
          <li>On the iPhone, open Shortcuts, make a new shortcut and add the action <b>Get Contents of URL</b>.</li>
          <li>Paste the address as its URL. Open the action's options: Method <b>POST</b>, Request Body <b>JSON</b>, one text field named <b>url</b> with the variable <b>Shortcut Input</b> as its value.</li>
          <li>In the shortcut's details switch on <b>Show in Share Sheet</b>, and name it Gym Tracker.</li>
          <li>In Instagram, TikTok or YouTube: Share → Gym Tracker. The video is under Saved Videos the next time this app is open.</li>
        </ol>
      </div>
    </Section>
  );
}
