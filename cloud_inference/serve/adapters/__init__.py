"""Model adapters for the Nori multi-policy inference server.

Adapter protocol (duck-typed; see base.py for the reference docstring):

    load()                                    heavy imports + weights; called once
                                              in a background thread
    act(images, state, instruction,
        num_steps, extras) -> (actions, dict) one action CHUNK, robot scale
    meta() -> dict                            {kind, chunk_hz, horizon, dof,
                                              cameras, max_images, source, ...}
    point(image, query, max_new_tokens)       OPTIONAL — pointing-capable VLMs only
"""
