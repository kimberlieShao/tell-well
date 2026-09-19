// Reuses the same read-only biometrics endpoint as Home. Selection is not OAuth.
window.mountWhoopSetup = function (container) {
  const checkbox=container.querySelector('input[name="devices"][value="WHOOP"]');
  const panel=container.querySelector('#whoopConnection');
  if(!checkbox||!panel)return ()=>{};
  const status=panel.querySelector('[role="status"]'),retry=panel.querySelector('button');
  let request=null,generation=0;
  function cancel(){generation++;request?.abort();request=null;}
  async function check(){
    cancel();panel.hidden=!checkbox.checked;if(!checkbox.checked)return;
    const current=generation;const controller=new AbortController();request=controller;
    status.textContent='Checking the current WHOOP connection…';retry.hidden=true;
    const timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const response=await fetch('/api/biometrics?days=1',{signal:controller.signal});
      if(!response.ok)throw new Error('unavailable');
      const data=await response.json();
      if(current!==generation||!checkbox.checked)return;
      if(data.connected===true&&data.source==='whoop'){
        status.textContent=data.date?`WHOOP data available · Latest record: ${data.date}. Continue to Home to see your measurements.`:'WHOOP connected. No measurements are available yet.';
      }else if(data.connected===true&&data.source==='demo'){
        status.textContent='The server is using sample wearable data, not a live WHOOP connection.';
      }else{
        const messages={not_running:'The WHOOP connector is not running. Start the existing connector, then try again.',not_connected:'WHOOP is not authorized yet. Connect it through the existing WHOOP connector, then try again.',reconnect:'WHOOP authorization has expired. Reconnect through the existing connector, then try again.',not_configured:'WHOOP is not configured on this server yet.'};
        status.textContent=messages[data.reason]||'WHOOP data is unavailable right now. You can continue setup and retry later.';
      }
    }catch{if(current===generation)status.textContent='Could not check WHOOP. You can continue setup and try again later.';}
    finally{clearTimeout(timeout);if(current===generation)retry.hidden=false;}
  }
  function changed(event){if(event.target.id==='noDevices'&&event.target.checked)checkbox.checked=false;if(event.target===checkbox||event.target.id==='noDevices')check();}
  container.addEventListener('change',changed);retry.addEventListener('click',check);check();
  return ()=>{cancel();container.removeEventListener('change',changed);retry.removeEventListener('click',check);};
};
