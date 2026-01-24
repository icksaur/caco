// Scroll to bottom when new messages arrive
document.body.addEventListener('htmx:afterSwap', () => {
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
});

// Handle image paste - with debugging
document.addEventListener('paste', (e) => {
  console.log('Paste event fired!', e);
  
  const items = e.clipboardData?.items;
  console.log('Clipboard items:', items);
  
  if (!items) {
    console.log('No clipboard items found');
    return;
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`Item ${i}:`, item.type, item.kind);
    
    if (item.type.indexOf('image') !== -1) {
      console.log('Image found!');
      e.preventDefault();
      const blob = item.getAsFile();
      console.log('Blob:', blob);
      
      const reader = new FileReader();
      
      reader.onload = (event) => {
        const base64 = event.target.result;
        console.log('Base64 length:', base64.length);
        document.getElementById('imageData').value = base64;
        document.getElementById('previewImg').src = base64;
        document.getElementById('imagePreview').classList.add('visible');
      };
      
      reader.onerror = (error) => {
        console.error('FileReader error:', error);
      };
      
      reader.readAsDataURL(blob);
      break;
    }
  }
});

// Remove attached image
function removeImage() {
  document.getElementById('imageData').value = '';
  document.getElementById('previewImg').src = '';
  document.getElementById('imagePreview').classList.remove('visible');
}

// Test clipboard access on page load
console.log('Clipboard API available:', 'clipboard' in navigator);
console.log('Page loaded and ready for paste');
