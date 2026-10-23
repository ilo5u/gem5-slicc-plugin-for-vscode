'use strict';

// Separate registrations supply distinct file icons; all language features are shared.
const languageIds = ['slicc', 'slicc-list'];
const selector = languageIds.map(language => ({ language }));
function isSliccDocument(document) { return languageIds.includes(document?.languageId); }

module.exports = { selector, isSliccDocument };
