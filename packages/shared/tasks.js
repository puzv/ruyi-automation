const path = require('node:path')
const { automationRoot } = require('./paths')

const scripts = Object.freeze({
  upload: path.join(automationRoot, 'uploadAll.js'),
  create: path.join(automationRoot, 'createAllGroup.js'),
  analyse: path.join(automationRoot, 'analyseAll.js'),
  download: path.join(automationRoot, 'downloadAll.js'),
})

module.exports = { scripts }
