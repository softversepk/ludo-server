const fs = require('fs');

function convertToCJS(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace imports
  content = content.replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];/g, (match, imports, path) => {
    let p = path.replace('../constants/', './');
    return `const { ${imports} } = require('${p}');`;
  });

  // Replace export const
  content = content.replace(/export\s+const\s+(\w+)/g, 'exports.$1');
  
  fs.writeFileSync(filePath, content);
}

convertToCJS('server/utils/chessConstants.js');
convertToCJS('server/utils/chessLogic.js');
console.log('Conversion done.');