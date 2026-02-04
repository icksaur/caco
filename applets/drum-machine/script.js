var audioCtx = null;
var isPlaying = false;
var currentStep = 0;
var intervalId = null;

var drums = [
  { name: 'Kick', freq: 60, decay: 0.5 },
  { name: 'Snare', freq: 200, decay: 0.2 },
  { name: 'HiHat', freq: 800, decay: 0.05 },
  { name: 'Clap', freq: 400, decay: 0.15 }
];

var pattern = drums.map(function() {
  return new Array(16).fill(false);
});

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playSound(drum) {
  initAudio();
  var osc = audioCtx.createOscillator();
  var gain = audioCtx.createGain();
  
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  
  var now = audioCtx.currentTime;
  
  if (drum.name === 'Kick') {
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + drum.decay);
  } else {
    osc.frequency.setValueAtTime(drum.freq, now);
  }
  
  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + drum.decay);
  
  if (drum.name === 'HiHat' || drum.name === 'Snare') {
    osc.type = 'square';
  }
  
  osc.start();
  osc.stop(audioCtx.currentTime + drum.decay);
}

function renderGrid() {
  var grid = document.getElementById('grid');
  var html = '';
  
  for (var r = 0; r < drums.length; r++) {
    html += '<div class="row">';
    html += '<span class="row-label">' + drums[r].name + '</span>';
    html += '<div class="steps">';
    for (var c = 0; c < 16; c++) {
      var active = pattern[r][c] ? ' active' : '';
      html += '<div class="step' + active + '" data-row="' + r + '" data-col="' + c + '"></div>';
    }
    html += '</div></div>';
  }
  
  grid.innerHTML = html;
  
  grid.querySelectorAll('.step').forEach(function(step) {
    step.addEventListener('click', function() {
      var r = parseInt(this.getAttribute('data-row'));
      var c = parseInt(this.getAttribute('data-col'));
      pattern[r][c] = !pattern[r][c];
      this.classList.toggle('active');
      if (pattern[r][c]) playSound(drums[r]);
      syncPattern();
    });
  });
}

function syncPattern() {
  setAppletState({
    drums: drums.map(function(d) { return d.name; }),
    steps: 16,
    pattern: pattern
  });
}

function tick() {
  document.querySelectorAll('.step.playing').forEach(function(el) {
    el.classList.remove('playing');
  });
  
  for (var r = 0; r < drums.length; r++) {
    var step = document.querySelector('.step[data-row="' + r + '"][data-col="' + currentStep + '"]');
    if (step) step.classList.add('playing');
    if (pattern[r][currentStep]) {
      playSound(drums[r]);
    }
  }
  
  currentStep = (currentStep + 1) % 16;
}

function togglePlay() {
  var btn = document.getElementById('playBtn');
  var bpm = parseInt(document.getElementById('bpm').value) || 120;
  
  if (isPlaying) {
    clearInterval(intervalId);
    isPlaying = false;
    btn.textContent = '▶ Play';
    btn.classList.remove('playing');
    document.querySelectorAll('.step.playing').forEach(function(el) {
      el.classList.remove('playing');
    });
    currentStep = 0;
  } else {
    initAudio();
    isPlaying = true;
    btn.textContent = '⏹ Stop';
    btn.classList.add('playing');
    var interval = (60 / bpm / 4) * 1000;
    tick();
    intervalId = setInterval(tick, interval);
  }
}

document.getElementById('playBtn').addEventListener('click', togglePlay);
document.getElementById('bpm').addEventListener('change', function() {
  if (isPlaying) {
    togglePlay();
    togglePlay();
  }
});

renderGrid();
setAppletState({ drums: drums.map(function(d) { return d.name; }), steps: 16 });