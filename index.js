const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Discovery endpoint
app.options('/cds-services', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.sendStatus(200);
});

app.get('/inspect/http', (req, res) => {
  res.send('Inspect HTTP endpoint reached!');
});
// CDS Services discovery endpoint

app.get('/cds-services', (req, res) => {
  res.json({
    services: [
      {
        hook: "order-select",
        title: "TNBC Alert",
        description: "Triggers a card when patient has undergone genetic testing for BRCA1/BRCA2 and has a specific neoadjuvant status.",
        id: "pgx-on-order",
        prefetch: {
          patient: "Patient/{{context.patientId}}",
          geneticReport: "DocumentReference?patient={{context.patientId}}"
        }
      }
    ]
  });
});

// CDS Service for pgx on Order
app.post('/cds-services/pgx-on-order', (req, res) => {
  // Handle geneticReport as Bundle or as a single resource
  const geneticReportPrefetch = req.body.prefetch?.geneticReport;
  let geneticReports = [];
  if (geneticReportPrefetch) {
    if (geneticReportPrefetch.resourceType === "Bundle" && Array.isArray(geneticReportPrefetch.entry)) {
      geneticReports = geneticReportPrefetch.entry.map(e => e.resource);
    } else {
      geneticReports = [geneticReportPrefetch];
    }
  }

  // Check BRCA status and if a genetic test was done
  let brca1Detected = false;
  let brca2Detected = false;
  let brcaBothDetected = false;
  let brcaNeitherDetected = false;
  let brcaTestDone = false;
  let postNeoStatusDetected = false;

  for (const report of geneticReports) {
    const desc = report.description || "";
    if (desc.includes("was detected in both the BRCA1 gene and the BRCA2 gene")) {
      brcaBothDetected = true;
      brcaTestDone = true;
    }
    if (desc.includes("was detected in the BRCA1 gene")) {
      brca1Detected = true;
      brcaTestDone = true;
    }
    if (desc.includes("was detected in the BRCA2 gene")) {
      brca2Detected = true;
      brcaTestDone = true;
    }
    if (desc.includes("was not detected in neither the BRCA1 gene nor the BRCA2 gene")) {
      brcaNeitherDetected = true;
      brcaTestDone = true;
    }
    // If any of the above phrases are present, a test was done
    if (
      desc.includes("was detected in both the BRCA1 gene and the BRCA2 gene") ||
      desc.includes("was detected in the BRCA1 gene") ||
      desc.includes("was detected in the BRCA2 gene") ||
      desc.includes("was not detected in neither the BRCA1 gene nor the BRCA2 gene")
    ) {
      brcaTestDone = true;
    }
    // Check for post-neoadjuvant status
    if (/ypT[0-4]N[0-3]|ypT0N[1-3]/.test(desc)) {
      postNeoStatusDetected = true;
    }
  }

  // ypT#N# and pembro not given string must be in the same document
  let postNeoAndPembroFound = false;
  let postNeoStatusString = "";
  for (const report of geneticReports) {
    const desc = report.description || "";
    const postNeoMatch = desc.match(/ypT[1-4]N[0-3]|ypT0N[1-3]/);
    const pembroStringFound = desc.includes("pembrolizumab-containing regimen was not given preoperatively");
    if (postNeoMatch && pembroStringFound) {
      postNeoAndPembroFound = true;
      postNeoStatusString = postNeoMatch[0];
      break;
    }
  }

  // ypT#N# and pembro given string must be in the same document
  let postNeoAndPembroGivenFound = false;
  let postNeoStatusGivenString = "";
  for (const report of geneticReports) {
    const desc = report.description || "";
    const postNeoMatch = desc.match(/ypT[1-4]N[0-3]|ypT0N[1-3]/);
    const pembroGivenStringFound = desc.includes("pembrolizumab-containing regimen was given preoperatively");
    if (postNeoMatch && pembroGivenStringFound) {
      postNeoAndPembroGivenFound = true;
      postNeoStatusGivenString = postNeoMatch[0];
      break;
    }
  }

  let cards = [];

  // Recommend genetic testing if not done AND post-neoadjuvant status is present
  if (!brcaTestDone && postNeoStatusDetected) {
    cards.push({
      summary: "BRCA Genetic Test Not Found",
      detail: "No evidence of BRCA1/BRCA2 genetic testing found in the patient's records. Recommend ordering BRCA genetic testing.",
      indicator: "info",
      source: {
        label: "Genetic Testing Recommendation",
        type: "absolute",
        url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
      },
      suggestions: [
        {
          label: "Order BRCA Genetic Test",
          uuid: "order-brca-genetic-test",
          actions: [
            {
              type: "create",
              description: "Order BRCA1/BRCA2 genetic testing.",
              resource: {
                resourceType: "ServiceRequest",
                status: "active",
                intent: "order",
                code: {
                  coding: [
                    {
                      system: "http://loinc.org",
                      code: "81247-9",
                      display: "BRCA1 and BRCA2 gene analysis"
                    }
                  ],
                  text: "BRCA1 and BRCA2 gene analysis"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        },
        {
          label: "Dismiss",
          uuid: "dismiss-card",
          actions: [
            {
              type: "delete",
              description: "Dismiss this recommendation card."
            }
          ]
        }
      ],
      selectionBehavior: "at-most-one"
    });
  }

  // Alerts for BRCA status
  let geneSummary = "";
  let geneDetail = "";
  if (brcaBothDetected) {
    geneSummary = "BRCA1 & BRCA2 Pathogenic Variants Detected";
    geneDetail = "Patient has pathogenic variants detected in both the BRCA1 and BRCA2 genes.";
  } else if (brca1Detected && brca2Detected) {
    geneSummary = "BRCA1 & BRCA2 Pathogenic Variants Detected";
    geneDetail = "Patient has pathogenic variants detected in both the BRCA1 and BRCA2 genes.";
  } else if (brca1Detected) {
    geneSummary = "BRCA1 Pathogenic Variant Detected";
    geneDetail = "Patient has a pathogenic variant detected in the BRCA1 gene.";
  } else if (brca2Detected) {
    geneSummary = "BRCA2 Pathogenic Variant Detected";
    geneDetail = "Patient has a pathogenic variant detected in the BRCA2 gene.";
  } else if (brcaNeitherDetected) {
    geneSummary = "No BRCA1 or BRCA2 Pathogenic Variants Detected";
    geneDetail = "No pathogenic variants detected in BRCA1 or BRCA2 genes.";
  } else if (!brcaTestDone) {
    geneSummary = "BRCA Genetic Test Not Found";
    geneDetail = "No evidence of BRCA1/BRCA2 genetic testing found in the patient's records.";
  }

  // Alert for post-neoadjuvant status with pembro not given
  if (postNeoAndPembroFound) {
    cards.push({
      summary: `${geneSummary}. Pathology: ${postNeoStatusString}`,
      detail: `${geneDetail} Residual cancer after neoadjuvant therapy (pathology: ${postNeoStatusString}), and did not receive a pembrolizumab-containing regimen preoperatively.`,
      indicator: "warning",
      source: {
        label: "NCCN CPG pg. 29",
        type: "absolute",
        url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
      },
      suggestions: [
        ...(brcaBothDetected || brca1Detected || brca2Detected ? [{
          label: "Add Olaparib (Strongly Recommended)",
          uuid: "add-olaparib",
          actions: [
            {
              type: "create",
              description: "Add Olaparib (RxNorm 1792776) to orders.",
              resource: {
                resourceType: "MedicationRequest",
                status: "active",
                intent: "order",
                medicationCodeableConcept: {
                  coding: [
                    {
                      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                      code: "1792776",
                      display: "Olaparib"
                    }
                  ],
                  text: "Olaparib"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        }] : []),
        {
          label: "Add Capecitabine",
          uuid: "add-capecitabine",
          actions: [
            {
              type: "create",
              description: "Add Capecitabine (RxNorm 205740) to orders.",
              resource: {
                resourceType: "MedicationRequest",
                status: "active",
                intent: "order",
                medicationCodeableConcept: {
                  coding: [
                    {
                      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                      code: "205740",
                      display: "Capecitabine"
                    }
                  ],
                  text: "Capecitabine"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        },
        {
          label: "Dismiss",
          uuid: "dismiss-card",
          actions: [
            {
              type: "delete",
              description: "Dismiss this recommendation card."
            }
          ]
        }
      ],
      selectionBehavior: "at-most-one"
    });
  }

  // Alert for post-neoadjuvant status with pembrolizumab not given
  if (postNeoAndPembroGivenFound) {
    cards.push({
      summary: `${geneSummary}. Pathology: ${postNeoStatusGivenString}`,
      detail: `${geneDetail} Residual cancer after neoadjuvant therapy (pathology: ${postNeoStatusGivenString}), and DID receive a pembrolizumab-containing regimen preoperatively.`,
      indicator: "warning",
      source: {
        label: "NCCN CPG pg. 29",
        type: "absolute",
        url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
      },
      suggestions: [
        ...(brcaBothDetected || brca1Detected || brca2Detected ? [{
          label: "Add Olaparib (Strongly Recommended)",
          uuid: "add-olaparib",
          actions: [
            {
              type: "create",
              description: "Add Olaparib (RxNorm 1792776) to orders.",
              resource: {
                resourceType: "MedicationRequest",
                status: "active",
                intent: "order",
                medicationCodeableConcept: {
                  coding: [
                    {
                      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                      code: "1792776",
                      display: "Olaparib"
                    }
                  ],
                  text: "Olaparib"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        }] : []),
        {
          label: "Add Capecitabine",
          uuid: "add-capecitabine",
          actions: [
            {
              type: "create",
              description: "Add Capecitabine (RxNorm 205740) to orders.",
              resource: {
                resourceType: "MedicationRequest",
                status: "active",
                intent: "order",
                medicationCodeableConcept: {
                  coding: [
                    {
                      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                      code: "205740",
                      display: "Capecitabine"
                    }
                  ],
                  text: "Capecitabine"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        },
        {
          label: "Add Pembrolizumab",
          uuid: "add-pembrolizumab",
          actions: [
            {
              type: "create",
              description: "Add Pembrolizumab (RxNorm 1789221) to orders.",
              resource: {
                resourceType: "MedicationRequest",
                status: "active",
                intent: "order",
                medicationCodeableConcept: {
                  coding: [
                    {
                      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                      code: "1789221",
                      display: "Pembrolizumab"
                    }
                  ],
                  text: "Pembrolizumab"
                },
                subject: {
                  reference: `Patient/${req.body.context?.patientId || "unknown"}`
                }
              }
            }
          ]
        },
        {
          label: "Dismiss",
          uuid: "dismiss-card",
          actions: [
            {
              type: "delete",
              description: "Dismiss this recommendation card."
            }
          ]
        }
      ],
      selectionBehavior: "at-most-one"
    });
  }
  // Alert for ypT0N0 status
  for (const report of geneticReports) {
    const desc = report.description || "";
    const ypT0N0Match = desc.match(/ypT0N0/);
    const pcrFound = desc.includes("pCR");
    if (ypT0N0Match || pcrFound) {
      cards.push({
        summary: "No Residual Cancer Detected (ypT0N0 or pCR)",
        detail: "Pathology report indicates ypT0N0 status or pCR (no residual cancer after neoadjuvant therapy). ",
        indicator: "info",
        source: {
          label: "NCCN Regimen Criteria",
          type: "absolute",
          url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
        },
        suggestions: [
          {
            label: "Dismiss",
            uuid: "dismiss-card",
            actions: [
              {
                type: "delete",
                description: "Dismiss this recommendation card."
              }
            ]
          },
          {
            label: "View Regimen Criteria",
            uuid: "view-regimen-criteria",
            actions: [
              {
                type: "link",
                description: "View NCCN regimen criteria.",
                url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
              }
            ]
          },
          {
            label: "Add Pembrolizumab",
            uuid: "add-pembrolizumab",
            actions: [
              {
                type: "create",
                description: "Add Pembrolizumab (RxNorm 1789221) to orders.",
                resource: {
                  resourceType: "MedicationRequest",
                  status: "active",
                  intent: "order",
                  medicationCodeableConcept: {
                    coding: [
                      {
                        system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                        code: "1789221",
                        display: "Pembrolizumab"
                      }
                    ],
                    text: "Pembrolizumab"
                  },
                  subject: {
                    reference: `Patient/${req.body.context?.patientId || "unknown"}`
                  }
                }
              }
            ]
          }
        ],
        selectionBehavior: "at-most-one"
      });
      break;
    }
  }
  for (const report of geneticReports) {
    const desc = report.description || "";
    const hasPembroGiven = desc.includes("pembrolizumab-containing regimen was given preoperatively");
    const hasPembroNotGiven = desc.includes("pembrolizumab-containing regimen was not given preoperatively");
    const ypTMatch = desc.match(/ypT[1-4]N[0-3]|ypT0N[1-3]/);

    // If pathology report has ypT status but no pembro info
    if (ypTMatch && !hasPembroGiven && !hasPembroNotGiven) {
      cards.push({
        summary: "Check Patient's Treatment History",
        detail: `Pathology report indicates residual cancer (pathology: ${ypTMatch[0]}). ${geneDetail} Does not specify if pembrolizumab-containing regimen was given preoperatively. Please check the patient's treatment history.`,
        indicator: "warning",
        source: {
          label: "NCCN CPG pg. 29",
          type: "absolute",
          url: "https://www.nccn.org/guidelines/guidelines-detail?category=1&id=1419"
        },
        suggestions: [
          ...(brcaBothDetected || brca1Detected || brca2Detected ? [{
            label: "Add Olaparib (Strongly Recommended)",
            uuid: "add-olaparib",
            actions: [
              {
                type: "create",
                description: "Add Olaparib (RxNorm 1792776) to orders.",
                resource: {
                  resourceType: "MedicationRequest",
                  status: "active",
                  intent: "order",
                  medicationCodeableConcept: {
                    coding: [
                      {
                        system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                        code: "1792776",
                        display: "Olaparib"
                      }
                    ],
                    text: "Olaparib"
                  },
                  subject: {
                    reference: `Patient/${req.body.context?.patientId || "unknown"}`
                  }
                }
              }
            ]
          }] : []),
          {
            label: "Add Capecitabine",
            uuid: "add-capecitabine",
            actions: [
              {
                type: "create",
                description: "Add Capecitabine (RxNorm 205740) to orders.",
                resource: {
                  resourceType: "MedicationRequest",
                  status: "active",
                  intent: "order",
                  medicationCodeableConcept: {
                    coding: [
                      {
                        system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                        code: "205740",
                        display: "Capecitabine"
                      }
                    ],
                    text: "Capecitabine"
                  },
                  subject: {
                    reference: `Patient/${req.body.context?.patientId || "unknown"}`
                  }
                }
              }
            ]
          },
          {
            label: "Add Pembrolizumab",
            uuid: "add-pembrolizumab",
            actions: [
              {
                type: "create",
                description: "Add Pembrolizumab (RxNorm 1789221) to orders.",
                resource: {
                  resourceType: "MedicationRequest",
                  status: "active",
                  intent: "order",
                  medicationCodeableConcept: {
                    coding: [
                      {
                        system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                        code: "1789221",
                        display: "Pembrolizumab"
                      }
                    ],
                    text: "Pembrolizumab"
                  },
                  subject: {
                    reference: `Patient/${req.body.context?.patientId || "unknown"}`
                  }
                }
              }
            ]
          },
          {
            label: "Dismiss",
            uuid: "dismiss-card",
            actions: [
              {
                type: "delete",
                description: "Dismiss this recommendation card."
              }
            ]
          }
        ],
        selectionBehavior: "at-most-one"
      });
      break;
    }
  }
  res.json({ cards });
});


// Start the server
const PORT = 4040;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}
);
