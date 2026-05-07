### **Namespace**:
Canonical resource grammar:
`me://namespace[selector]/path`
Implementation-specific daemon command surface:
`me://namespace:operation/path`
**1 key = 1 subject = N monads.ai**
**namespace** = canonical resource namespace
**selector** = canonical NRP selector when using the resource grammar
**operation** = daemon/kernel command intent when using the command surface
**path** = semantic route or command target

El claim ahora está anclado al identity hash del kernel en lugar de derivarlo de `namespace + secret`.

The recommended canonical resource form is the one specified by the [Namespace Resolution Protocol](../../docs/en/Namespace%20Resolution%20Protocol.md). Command-style `me://namespace:operation/path` targets remain part of the current daemon implementation surface, but they do not replace the canonical NRP grammar.

---

```.me
me://self:read/profile
me://self:write/profile.name
me://self:inspect/profile
me://self:explain/profile.netWorth
me://kernel:read/memory
me://kernel:export/snapshot
me://kernel:import/snapshot
me://kernel:replay/memory
me://kernel:rehydrate/snapshot
me://kernel:get/recompute.mode
me://kernel:set/recompute.mode
me://kernel[device:localhost|protocol:http|port:8161]:export/snapshot
me://ana[host:foo|protocol:https]:read/profile
me://wikileaks[host:wikileaks.org|protocol:https]:read/page
```

---

1. **Explainability:** `me://self:explain/profile.netWorth` is readable by humans and machines. It’s a request for a logic trace on a specific data point.
2. **Remote Kernel Control:** `me://kernel[host:office]:rehydrate/snapshot` allows you to manage a remote daemon with the exact same syntax as a local one.
3. **Clean Ledger:** Every entry in the `monad.ai` ledger will now follow a strict `Subject -> Action -> Object` structure, making audits and replays trivial.

---

So now the current **daemon command surface** reads cleanly:
`me://self:read/profile`
`me://self:write/profile.name`
`me://kernel:export/snapshot`
`me://kernel:replay/memory`

---

# **Algebra of Encrypted Audiences**
In this algebra, access and visibility are determined by the interplay of three sets:
- **Context** defines *where* and *on which nodes* data resides.
- **Capability** defines *which actions* are permitted on the data.
- **Encryption** defines *who can decrypt* and read the content.

Mathematically, we express these properties as three sets:

- **T** = *Topology set*
  - On which nodes does the ciphertext exist or replicate?
- **A** = *Audience set*
  - Which identities are authorized to decrypt?
- **P** = *Procedure/Capability set*
  - What actions can be performed on this content?

Thus, an **“encrypted island”** can be formally represented as:

```
Island I = (path, ciphertext, T, A, P)
```

**Example:**  
Suppose an image is saved and replicated across:

- `office-node`
- `iphone`
- `backup-daemon`

Topology set:

```
T = {office, iphone, backup}
```

But only you and your spouse can decrypt it:

```
A = {me, wife}
```

In other words:

- **Multiple nodes may store the island**, but only a specific subset of users can read it.

---

A clean way to conceptualize this is:

- **“Space” is the primary entity:** all other properties are predicates or projections over that space.
- Everything else—membership, replication, visibility, or capabilities—is expressed as refinements, unions, intersections, or other set operations.

Common cases, then, are simple statements about the sets:

| Property        | Predicate                                   |
| --------------- | ------------------------------------------- |
| **private**     | `A = {self}`                                |
| **shared**      | `|A| > 1`                                   |
| **public**      | `A` is open or broadly readable             |
| **encrypted**   | Access to `A` is enforced cryptographically |
| **replicated**  | `|T| > 1`                                   |
| **local**       | `T` includes only the local node            |
| **distributed** | `T` includes remote or multiple nodes       |

**You can formalize any “space” as:**

- **A**: The audience set (who can read)
- **T**: The topology set (where it lives)
- **C**: The capability/action set (what can be done)
- **P**: The path/subspace (context or semantic location)

**Adjectives** like “private”, “shared”, “replicated”, or “encrypted” are then just properties over those sets. For example:

- **private**: Only the owner can read (`A = {self}`)
- **shared**: More than one party can read (`|A| > 1`)
- **public**: Anyone can read (`A` is open)
- **replicated**: The content exists on multiple nodes (`|T| > 1`)
- **encrypted**: Only members of `A` can decrypt, enforced cryptographically

This algebra enables rigorous, composable modeling of trust, replication, and control in distributed, encrypted systems.
---
