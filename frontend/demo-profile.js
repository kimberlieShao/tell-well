// The example person's profile, handed from the demo switch (demo-toggle.js) to the Profile page
// (new-ui.js). It is set only while the demo is on, and the page reloads when the demo is turned off.

let profile = null;

export const setDemoProfile = value => { profile = value ?? null; };
export const getDemoProfile = () => profile;
