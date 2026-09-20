/* Frontend-only account screens. Demo sign-in only: no credential verification, credential storage or account API. */
(() => {
  const screen = document.getElementById('screen');
  const status = document.getElementById('status');
  let mode = 'signin';
  const copy = {
    signin: { title: 'Welcome back', subtitle: 'Demo: enter any username and password to explore.', action: 'Sign in' },
    signup: { title: 'Make space for your health', subtitle: 'Create your account to get started.', action: 'Create account' },
    reset: { title: 'Forgot your password?', subtitle: 'Enter the email address you use for Tell-Well.', action: 'Send reset link' }
  };
  function passwordField(id, label, autocomplete) {
    return `<label for="${id}">${label}</label><div class="password-field"><input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required aria-describedby="${id}-error${id==='password'&&mode==='signup'?' password-help':''}"><button type="button" data-toggle="${id}" aria-label="Show ${label.toLowerCase()}" aria-pressed="false">Show</button></div><p class="field-error" id="${id}-error"></p>`;
  }
  function render(focus = true) {
    const c = copy[mode];
    document.title = `${mode==='signin'?'Sign in':mode==='signup'?'Sign up':'Reset password'} · Tell-Well`;
    status.textContent = '';
    screen.innerHTML = `<h2 tabindex="-1">${c.title}</h2><p class="subtitle">${c.subtitle}</p>${mode!=='reset'?'<button type="button" class="google" id="google"><span aria-hidden="true">G</span>Continue with Google</button><div class="divider">or use your email</div>':''}<form id="authForm" novalidate><label for="email">${mode==='signin'?'Username or email':'Email address'}</label><input id="email" name="email" type="${mode==='signin'?'text':'email'}" autocomplete="${mode==='signin'?'off':'email'}" inputmode="${mode==='signin'?'text':'email'}" autocapitalize="none" spellcheck="false" placeholder="you@example.com" required aria-describedby="email-error"><p class="field-error" id="email-error"></p>${mode!=='reset'?passwordField('password','Password',mode==='signup'?'new-password':'off'):''}${mode==='signup'?'<p id="password-help" class="help">Use at least 8 characters. Final account requirements will be confirmed when sign-up is connected.</p>'+passwordField('confirmPassword','Confirm password','new-password'):''}${mode==='signin'?'<div class="row"><button class="link-button" type="button" data-mode="reset">Forgot password?</button></div>':''}<button class="primary" type="submit">${c.action}</button></form><p class="switch-copy">${mode==='signin'?'New to Tell-Well? <button type="button" class="link-button" data-mode="signup">Create an account</button>':'<button type="button" class="link-button" data-mode="signin">← Back to sign in</button>'}</p>`;
    if(focus) screen.querySelector('h2').focus();
  }
  screen.addEventListener('click', event => {
    const button = event.target.closest('button');
    if(!button) return;
    if(button.dataset.mode){mode=button.dataset.mode;render();return;}
    if(button.dataset.toggle){
      const input=document.getElementById(button.dataset.toggle);
      const showing=input.type==='password';
      input.type=showing?'text':'password';button.textContent=showing?'Hide':'Show';
      button.setAttribute('aria-pressed',String(showing));
      button.setAttribute('aria-label',`${showing?'Hide':'Show'} ${input.id==='confirmPassword'?'confirm password':'password'}`);
    }
    if(button.id==='google') status.textContent='Google sign-in is not connected yet. No Google account has been linked or signed in.';
  });
  screen.addEventListener('input', event => {
    status.textContent='';
    const error=document.getElementById(`${event.target.id}-error`);
    if(error){error.textContent='';event.target.removeAttribute('aria-invalid');}
  });
  screen.addEventListener('submit',event=>{
    event.preventDefault();status.textContent='';
    const email=document.getElementById('email');email.value=email.value.trim();
    const password=document.getElementById('password'),confirm=document.getElementById('confirmPassword');
    let firstInvalid=null;
    function error(input,message){document.getElementById(`${input.id}-error`).textContent=message;if(message){input.setAttribute('aria-invalid','true');firstInvalid??=input;}else input.removeAttribute('aria-invalid');}
    error(email,!email.value?(mode==='signin'?'Enter any demo username or email.':'Enter your email address.'):mode!=='signin'&&email.validity.typeMismatch?'Enter a valid email address.':'');
    if(password)error(password,!password.value?'Enter your password.':mode==='signup'&&password.value.length<8?'Use at least 8 characters.':'');
    if(confirm)error(confirm,!confirm.value?'Confirm your password.':confirm.value!==password.value?'Passwords do not match.':'');
    if(firstInvalid){firstInvalid.focus();return;}
    if(mode==='signin'){password.value='';email.value='';enterDemo();return;}
    status.textContent=mode==='signin'?'Your form is ready, but sign-in is not connected yet. You have not been signed in.':mode==='signup'?'Your form is ready, but registration is not connected yet. No account has been created.':'Password reset is not connected yet. No email has been sent.';
    // Do not retain password values once this preview submission is complete.
    if(password)password.value='';if(confirm)confirm.value='';
  });
  window.addEventListener('pagehide',()=>{screen.querySelectorAll('input').forEach(input=>{input.value='';});});
  function enterDemo(){
    try {
      const profile=window.PulsewiseProfile.read();
      window.location.assign(profile?.onboardingCompleted ? '/app' : '../onboarding/');
    } catch { status.textContent='Demo storage is unavailable or could not be read. Enable session storage or use a new browser tab; existing data was not replaced.'; }
  }
  document.getElementById('tryDemo').addEventListener('click',enterDemo);
  // Straight into the app: a blank profile, so nobody has to fill in setup first
  document.getElementById('skipSetup').addEventListener('click',()=>{
    try {
      window.PulsewiseProfile.save({id:crypto.randomUUID(),displayName:'Friend',profileNotes:'',photo:null,ageRange:null,
        conditions:null,medications:null,dietaryPreferences:null,allergies:null,trackingPreferences:[],devices:null,
        accessibility:{textSize:'normal',reduceMotion:false},reminders:{checkin:false,medication:false},onboardingCompleted:true});
      window.location.assign('/app');
    } catch { status.textContent='Demo storage is unavailable or could not be read. Enable session storage or use a new browser tab; existing data was not replaced.'; }
  });
  render(false);
})();
