const fs = require('fs');

function convertToCJS(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace imports
  content = content.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];/g, (match, imports, path) => {
    let p = path.replace('../constants/', './');
    p = p.replace('./gameLogic', './gameLogic');
    return `const { ${imports} } = require('${p}');`;
  });
  
  // Replace export const
  content = content.replace(/export\s+const\s+(\w+)/g, 'exports.$1');
  content = content.replace(/export\s+let\s+(\w+)/g, 'exports.$1');
  content = content.replace(/export\s+function\s+(\w+)/g, 'exports.$1 = function $1');
  
  // Replace export default
  content = content.replace(/export\s+default\s+([^;]+);/g, 'module.exports = $1;');

  fs.writeFileSync(filePath, content);
}

convertToCJS('server/utils/gameConstants.js');
convertToCJS('server/utils/gameLogic.js');
convertToCJS('server/utils/aiPlayer.js');
console.log('Conversion done.');