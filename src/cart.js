/* cart.js — gedeelde aanvraaglijst voor catering.html + verhuur.html
   Wordt op beide pagina's geladen via:
   <script src="cart.js" data-source="catering|verhuur" data-wa-text="..."></script>
   State (gekozen items + ingevulde velden) wordt in localStorage bewaard, zodat
   iemand die van catering.html naar verhuur.html gaat (of andersom) zijn lijst
   niet kwijtraakt — en in één keer een offerte kan aanvragen voor allebei. */
(function(){
'use strict';

var scriptEl = document.currentScript;
var PAGE_SOURCE = (scriptEl && scriptEl.dataset.source) || 'catering';
var WA_TEXT = (scriptEl && scriptEl.dataset.waText) || 'Hoi! Ik heb een vraag aan Boslaantje Doen.';

var STORAGE_KEY = 'boslaantje_aanvraag_v1';
var FORMSPREE_ENDPOINT = 'https://formspree.io/f/mvzepvgz';
// Make.com-webhook: stuurt dezelfde aanvraag ook naar de automatisering
// (Make → WeFact), los van Formspree — geen betaald Formspree-plan nodig.
var MAKE_WEBHOOK = 'https://hook.eu1.make.com/s4jcf81ke9yl4uuqqyoydf52lqivxl7p';
var WHATSAPP_NUMMER = '31318514916';
var LABEL = { catering: 'Catering', verhuur: 'Verhuur' };
var FIELD_IDS = ['datum', 'gasten', 'naam', 'contact', 'opm'];
var CROSS_SELL = {
catering: { text: 'Ook tafels, een tent of koeling nodig voor je feest?', linkText: 'Bekijk de verhuur', href: 'verhuur.html' },
verhuur: { text: 'Ook eten of drinken geregeld voor je feest?', linkText: 'Bekijk de catering', href: 'catering.html' }
};

function loadState(){
try{
var raw = localStorage.getItem(STORAGE_KEY);
if(raw){
var parsed = JSON.parse(raw);
if(parsed && typeof parsed === 'object'){
parsed.items = parsed.items || {};
parsed.fields = parsed.fields || {};
return parsed;
}
}
}catch(e){ /* localStorage niet beschikbaar of corrupte data — start leeg */ }
return { items: {}, fields: {} };
}
var state = loadState();
function saveState(){
try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
}

function fmt(n){
return '€ ' + (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');
}
function gastenCount(){
var g = parseInt(state.fields.gasten || '', 10);
return (g && g > 0) ? g : 1;
}
function lineTotal(item){
return item.qty * item.price;
}
function grandTotal(){
return Object.keys(state.items).reduce(function(s, k){ return s + lineTotal(state.items[k]); }, 0);
}

function render(){
var itemsEl = document.getElementById('cartItems');
if(!itemsEl) return;

var keys = Object.keys(state.items);
var totalQty = keys.reduce(function(s, k){ return s + state.items[k].qty; }, 0);
var countEl = document.getElementById('cartCount'); if(countEl) countEl.textContent = totalQty;
var mCount = document.getElementById('mCount'); if(mCount) mCount.textContent = totalQty;

if(!keys.length){
itemsEl.innerHTML = '<p class="cart-empty">Nog leeg — kies hierboven wat je nodig hebt.</p>';
} else {
var groups = { catering: [], verhuur: [] };
keys.forEach(function(k){
var src = state.items[k].source === 'verhuur' ? 'verhuur' : 'catering';
groups[src].push(k);
});

var html = '';
['catering', 'verhuur'].forEach(function(src){
if(!groups[src].length) return;
html += '<div class="cart-group-label">' + LABEL[src] + '</div>';
groups[src].forEach(function(k){
var item = state.items[k];
html += '<div class="cart-item">' +
'<span class="nm">' + k + (item.unit ? ' <em>· ' + item.unit + '</em>' : '') + '</span>' +
'<div class="qty"><button class="q" type="button" data-m="' + k + '" data-d="-1" aria-label="minder">–</button><span class="n">' + item.qty + '</span><button class="q" type="button" data-m="' + k + '" data-d="1" aria-label="meer">+</button></div>' +
'<span class="line-price">' + fmt(lineTotal(item)) + '</span>' +
'</div>';
});
});
html += '<div class="cart-total"><span>Richtprijs totaal</span><span class="amt">' + fmt(grandTotal()) + '</span></div>' +
'<p class="cart-total-note">Indicatief · definitieve offerte volgt</p>';

var otherSrc = PAGE_SOURCE === 'catering' ? 'verhuur' : 'catering';
if(!groups[otherSrc].length){
var cs = CROSS_SELL[PAGE_SOURCE];
html += '<p class="cart-crosssell">' + cs.text + ' <a href="' + cs.href + '">' + cs.linkText + ' →</a></p>';
}

itemsEl.innerHTML = html;

itemsEl.querySelectorAll('button.q').forEach(function(b){
b.addEventListener('click', function(){
var k = b.dataset.m, d = parseInt(b.dataset.d, 10);
if(!state.items[k]) return;
state.items[k].qty += d;
if(state.items[k].qty <= 0) delete state.items[k];
saveState(); render();
});
});
}
syncAddButtons();
}

function syncAddButtons(){
document.querySelectorAll('.pkg').forEach(function(p){
var nm = p.dataset.name, btn = p.querySelector('.add');
if(!btn) return;
if(state.items[nm]){ btn.classList.add('added'); btn.textContent = '✓ Toegevoegd'; }
else { btn.classList.remove('added'); btn.textContent = '+ In aanvraaglijst'; }
});
}

document.querySelectorAll('.pkg .add').forEach(function(btn){
btn.addEventListener('click', function(){
var p = btn.closest('.pkg');
var nm = p.dataset.name, unit = p.dataset.unit || '';
var price = parseFloat(p.dataset.price || '0') || 0;
var perPerson = unit === 'p.p.';
if(state.items[nm]){
delete state.items[nm];
} else {
// bij p.p.-items is 'aantal gasten' een handig startpunt, maar hierna vrij aan te passen
state.items[nm] = { qty: perPerson ? gastenCount() : 1, unit: unit, price: price, source: PAGE_SOURCE, perPerson: perPerson };
}
saveState(); render();
});
});

// velden onthouden en synchroniseren tussen de pagina's
FIELD_IDS.forEach(function(id){
var el = document.getElementById(id);
if(!el) return;
if(state.fields[id]) el.value = state.fields[id];
el.addEventListener('input', function(){
state.fields[id] = el.value;
saveState();
el.classList.remove('invalid');
});
});

function g(id){
var el = document.getElementById(id);
return el ? (el.value || '').trim() : (state.fields[id] || '');
}

function buildMessage(){
var lines = ['Aanvraag Boslaantje Doen', ''];
['catering', 'verhuur'].forEach(function(src){
var keys = Object.keys(state.items).filter(function(k){ return state.items[k].source === src; });
if(!keys.length) return;
lines.push(LABEL[src] + ':');
keys.forEach(function(k){
var item = state.items[k];
lines.push('• ' + item.qty + '× ' + k + ' (' + fmt(lineTotal(item)) + ')');
});
lines.push('');
});
lines.push('Richtprijs totaal: ' + fmt(grandTotal()) + ' (indicatief, geen definitieve offerte)');
lines.push('');
lines.push('Datum: ' + (g('datum') || '-'));
lines.push('Aantal gasten: ' + (g('gasten') || '-'));
lines.push('Naam: ' + (g('naam') || '-'));
lines.push('Contact: ' + (g('contact') || '-'));
if(g('opm')) lines.push('Opmerkingen: ' + g('opm'));
return lines.join('\n');
}

// Machineleesbare versie van de aanvraaglijst — voor automatische verwerking
// (bijv. via Make.com naar WeFact), naast de leesbare tekst uit buildMessage().
function buildItemsJSON(){
return JSON.stringify(Object.keys(state.items).map(function(k){
var item = state.items[k];
return {
omschrijving: k,
eenheid: item.unit || '',
aantal: item.qty,
prijs_per_stuk: item.price,
totaal: Math.round(lineTotal(item) * 100) / 100,
bron: item.source
};
}));
}

function valid(){
document.querySelectorAll('.cart-fields .invalid').forEach(function(el){ el.classList.remove('invalid'); });

if(!Object.keys(state.items).length){
showStatus('Je aanvraaglijst is nog leeg. Kies eerst een of meer items hierboven.', 'error');
return false;
}

var required = [
{ id: 'naam', label: 'je naam' },
{ id: 'contact', label: 'telefoon of e-mail' },
{ id: 'datum', label: 'de datum' }
];
var missing = [];
var firstInvalid = null;
required.forEach(function(r){
var el = document.getElementById(r.id);
if(el && !el.value.trim()){
el.classList.add('invalid');
missing.push(r.label);
if(!firstInvalid) firstInvalid = el;
}
});

if(missing.length){
showStatus('Vul nog in: ' + missing.join(', ') + '.', 'error');
if(firstInvalid) firstInvalid.focus();
return false;
}

return true;
}

var sendBtn = document.getElementById('sendMail');
var sendBtnLabel = sendBtn ? sendBtn.textContent : '';
var statusEl = document.getElementById('formStatus');

function showStatus(msg, kind){
if(!statusEl) return;
statusEl.textContent = msg;
statusEl.className = 'form-status show ' + kind;
}

if(sendBtn){
sendBtn.addEventListener('click', function(){
if(!valid()) return;
sendBtn.disabled = true;
sendBtn.textContent = 'Versturen…';
showStatus('', '');
statusEl.className = 'form-status';

var payload = {
_subject: 'Aanvraag catering/verhuur via website — ' + (g('naam') || 'onbekend'),
naam: g('naam'),
contact: g('contact'),
datum: g('datum'),
aantal_gasten: g('gasten'),
opmerkingen: g('opm'),
aanvraag: buildMessage(),
totaal_bedrag: (Math.round(grandTotal() * 100) / 100).toFixed(2),
items_json: buildItemsJSON()
};

// Los, "fire-and-forget" doorsturen naar Make voor automatische verwerking
// (WeFact-offerte). Geen invloed op het echte verstuurproces hieronder —
// als dit mislukt merkt de bezoeker daar niets van.
try{
fetch(MAKE_WEBHOOK, {
method: 'POST',
mode: 'no-cors',
headers: { 'Content-Type': 'text/plain' },
body: JSON.stringify(payload)
}).catch(function(){});
}catch(e){}

fetch(FORMSPREE_ENDPOINT, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
body: JSON.stringify(payload)
}).then(function(res){
if(!res.ok) throw new Error('Formspree-fout: ' + res.status);
sendBtn.textContent = '✓ Verstuurd';
showStatus('Bedankt! Je aanvraag is verstuurd — we reageren binnen één werkdag.', 'ok');
state = { items: {}, fields: {} };
saveState();
FIELD_IDS.forEach(function(id){ var el = document.getElementById(id); if(el) el.value = ''; });
render();
}).catch(function(){
sendBtn.disabled = false;
sendBtn.textContent = sendBtnLabel;
showStatus('Er ging iets mis bij het versturen. Probeer het nogmaals, bel 0318 – 514 916, of app ons via de knop hierboven.', 'error');
});
});
}

var sendWa = document.getElementById('sendWa');
if(sendWa){
sendWa.addEventListener('click', function(e){
if(!valid()){ e.preventDefault(); return; }
this.href = 'https://wa.me/' + WHATSAPP_NUMMER + '?text=' + encodeURIComponent(buildMessage());
});
}

// zwevende WhatsApp-knop — zelfde nummer, met vooringevuld bericht per pagina
var wf = document.getElementById('waFloat');
if(wf){ wf.href = 'https://wa.me/' + WHATSAPP_NUMMER + '?text=' + encodeURIComponent(WA_TEXT); }

render();
})();
