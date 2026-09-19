/* Tab-scoped demo profile. This is not authentication or a backend account. */
(function(root){
  const key='pulsewise.demo-profile.v1';
  function read(){
    const raw=root.sessionStorage.getItem(key);
    if(!raw)return null;
    const value=JSON.parse(raw);
    if(!value||value.version!==1||!value.profile||typeof value.profile.displayName!=='string')throw new Error('Saved demo profile could not be read.');
    return structuredClone(value.profile);
  }
  function save(profile){
    root.sessionStorage.setItem(key,JSON.stringify({version:1,profile}));
    root.dispatchEvent(new root.CustomEvent('pulsewise:profile',{detail:structuredClone(profile)}));
    return structuredClone(profile);
  }
  root.PulsewiseProfile={read,save,patch(change){const profile=read();if(!profile)throw new Error('Complete setup first.');return save({...profile,...change});},async loadProfile(){return read();},async saveProfile(profile){return save(profile);}};
})(window);
