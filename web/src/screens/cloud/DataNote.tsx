import { cloudConfig } from '../../lib/cloud/config';

/**
 * Where an account's data is kept and who can see it — shown before signing
 * up and again under Settings, because a person should be able to read it
 * before they hand anything over.
 */
export function DataNote() {
  const operator = cloudConfig?.operator;
  const region = cloudConfig?.region;
  return (
    <details className="data-note">
      <summary>Where your data is kept</summary>
      <ul>
        <li>
          Your workouts, exercises, body weight, saved videos and settings are stored in this browser and in a
          Google Firebase database{region ? ` in ${region}` : ''}, so that they follow you to your other devices.
        </li>
        <li>
          Through the app, only you can read them. {operator || 'The person who runs this copy of Gym Tracker'} could
          look at them in the database's own console, and Google stores them on that person's behalf. Nobody
          else has access, and nothing is shared or sold.
        </li>
        <li>
          Your email address and password are handled by Firebase Authentication, which processes them in the
          United States. The password is kept only as a one-way hash: nobody can read it, the person running
          this copy included.
        </li>
        <li>
          API keys you enter for the video models are never stored in the account. They are kept in this
          browser and go only to the analyzer whose address you enter on this device — an address that is
          not taken from the account either.
        </li>
        <li>
          Settings → Download Backup gives you a copy of everything at any time. Settings → Delete Account
          removes your records and your login from the database, for good; your address stays on the guest
          list until the person who runs this copy takes it off.
        </li>
      </ul>
    </details>
  );
}
