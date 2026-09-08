# Canonical runtime

This directory is the sole story-pipeline source in batch-24-multiAG. The scheduler modules are its siblings in engine/.
It consolidates auto-story-finish and night-batch-ops; original hashes and retained artifacts are recorded in
../../references/consolidation-inventory.json. Installation copies the entire matched engine tree to tools/auto/.
No old global skill is needed at runtime. Version updates are adopted only at an idle batch boundary after regression and installation checks.
